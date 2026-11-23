import { computed, ref, shallowRef, type ComputedRef, type Ref, type ShallowRef } from 'vue';
import type { TimelineActivity, TimelineActivityPage, TimelineItem } from '@hongyan/contracts';

/** 一轮读取的意图：初次进入、刷新、加载更多、失败重试、按选中活动补读。 */
export type RangeIntent =
  | { kind: 'initial' }
  | { kind: 'refresh' }
  | { kind: 'more' }
  | { kind: 'retry' }
  | { kind: 'focus'; activityId: string };

export type RangeOutcome =
  | { status: 'ok' }
  | { status: 'aborted' }
  | { status: 'failed'; failedPage: number; forbidden: boolean }
  | { status: 'unstable' };

export type SelectionState =
  | { kind: 'none' }
  | { kind: 'kept'; activity: TimelineActivity; slot: TimelineItem }
  | { kind: 'window-moved' }
  | { kind: 'schedule-updated' }
  | { kind: 'activity-missing' };

export interface RangeOptions {
  /** 同时在途的日程请求上限，必填且无默认值。 */
  maxInFlight: number;
  /** 页大小，与服务端请求一致。 */
  pageSize: number;
  /** 当前窗口 `[from, to)`，用于判断所选时段的开始时刻是否还在窗口内。 */
  window: () => { from: string; to: string };
  /** 当前选中身份：`item` 是活动 ID，`slot` 是时段键。 */
  selection: () => { item?: string; slot?: string };
}

export interface ScheduleRange {
  pages: ShallowRef<TimelineActivityPage[]>;
  rows: ComputedRef<TimelineActivity[]>;
  total: ComputedRef<number>;
  hasMore: ComputedRef<boolean>;
  evaluatedAt: ComputedRef<string>;
  running: Ref<boolean>;
  selection: ComputedRef<SelectionState>;
  run(intent: RangeIntent): Promise<RangeOutcome>;
  cancel(): void;
}

const ABORT = Symbol('schedule-range-abort');
const UNSTABLE = Symbol('schedule-range-unstable');

class PageFailure extends Error {
  readonly page: number;
  readonly reason: unknown;

  constructor(page: number, reason: unknown) {
    super('日程页读取失败');
    this.page = page;
    this.reason = reason;
  }
}

const forbidden = (cause: unknown) =>
  typeof cause === 'object' && cause !== null && (cause as { status?: number }).status === 403;

/**
 * 日程的读取与合并模型：页集合、跨页校验、重校准、查询代际与在途闸门。
 * 页面注入 `read` 把页号变成请求，模块不拼 URL、不读路由。
 */
export function createScheduleRange(
  read: (page: number) => Promise<TimelineActivityPage>,
  options: RangeOptions,
): ScheduleRange {
  if (!Number.isInteger(options.maxInFlight) || options.maxInFlight < 1)
    throw new TypeError('scheduleRange: maxInFlight 必须是大于 0 的整数');
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1)
    throw new TypeError('scheduleRange: pageSize 必须是大于 0 的整数');
  if (typeof options.window !== 'function') throw new TypeError('scheduleRange: 缺少 window');
  if (typeof options.selection !== 'function') throw new TypeError('scheduleRange: 缺少 selection');

  const pages = shallowRef<TimelineActivityPage[]>([]);
  const running = ref(false);
  const rows = computed(() => pages.value.flatMap((page) => page.items));
  const total = computed(() => pages.value[0]?.total ?? 0);
  const hasMore = computed(() => {
    const page = pages.value.at(-1);
    return !!page && page.page * options.pageSize < total.value;
  });
  const evaluatedAt = computed(() => pages.value[0]?.state_evaluated_at ?? '');

  let generation = 0;
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  let active: Promise<RangeOutcome> | undefined;
  let lastFailure: { intent: RangeIntent; failedPage: number } | undefined;

  function acquire() {
    if (inFlight < options.maxInFlight) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiting.push(() => {
        inFlight += 1;
        resolve();
      });
    });
  }

  function release() {
    inFlight -= 1;
    waiting.shift()?.();
  }

  async function fetchPage(page: number, gen: number) {
    await acquire();
    try {
      if (gen !== generation) throw ABORT;
      const data = await read(page);
      if (gen !== generation) throw ABORT;
      return data;
    } finally {
      release();
    }
  }

  /** 按页号升序领取，最多 `maxInFlight` 个在途；任一页失败即停止补页并回报最小失败页号。 */
  async function readPages(numbers: number[], gen: number): Promise<TimelineActivityPage[]> {
    const wanted = [...numbers];
    const results: TimelineActivityPage[] = [];
    let index = 0;
    let stopped = false;
    let failure: PageFailure | undefined;
    const worker = async () => {
      while (!stopped && index < wanted.length) {
        const page = wanted[index];
        index += 1;
        try {
          results.push(await fetchPage(page, gen));
        } catch (error) {
          stopped = true;
          if (error === ABORT) throw error;
          if (!failure || page < failure.page) failure = new PageFailure(page, error);
          return;
        }
      }
    };
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(wanted.length, options.maxInFlight) }, worker),
    );
    if (settled.some((result) => result.status === 'rejected' && result.reason === ABORT))
      throw ABORT;
    if (failure) throw failure;
    return results.sort((a, b) => a.page - b.page);
  }

  /**
   * 跨页一致性：页号与页大小对齐、同页状态时刻一致、非末页满页、按 (activity_code, id) 严格递增、
   * 覆盖全集时活动数等于 total、页集合内各页 total 相等。成立时返回可提交的页集合（必要时截断）。
   */
  function consistent(input: TimelineActivityPage[]): TimelineActivityPage[] | undefined {
    if (!input.length) return undefined;
    const sorted = [...input].sort((a, b) => a.page - b.page);
    if (sorted[0].page !== 1) return undefined;
    const expected = sorted[0].total;
    if (!sorted.every((page) => page.total === expected)) return undefined;
    const needed = Math.max(1, Math.ceil(expected / options.pageSize));
    const kept = sorted.slice(0, Math.min(sorted.length, needed));
    for (const [position, page] of kept.entries()) {
      if (page.page !== position + 1) return undefined;
      if (page.page_size !== options.pageSize) return undefined;
      if (!page.items.every((item) => item.state_evaluated_at === page.state_evaluated_at))
        return undefined;
      // partial 页只能出现在结果末页：还有后续页时本页必须是满页。
      if (page.page * options.pageSize < expected && page.items.length !== options.pageSize)
        return undefined;
    }
    const all = kept.flatMap((page) => page.items);
    if (kept.length * options.pageSize >= expected && all.length !== expected) return undefined;
    for (let i = 1; i < all.length; i += 1) {
      const previous = all[i - 1];
      const current = all[i];
      if (previous.activity_code > current.activity_code) return undefined;
      if (previous.activity_code === current.activity_code && previous.activity_id >= current.activity_id)
        return undefined;
    }
    return kept;
  }

  const pageNumbers = (from: number, to: number) =>
    Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);

  /** 取回目标页并整轮校验；不成立即从第 1 页整段重读一次，仍不成立判为未稳定。 */
  async function settle(
    numbers: number[],
    prefix: TimelineActivityPage[],
    gen: number,
  ): Promise<void> {
    const first = consistent([...prefix, ...(await readPages(numbers, gen))]);
    if (first) {
      pages.value = first;
      return;
    }
    const top = Math.max(...numbers, ...prefix.map((page) => page.page));
    const second = consistent(await readPages(pageNumbers(1, top), gen));
    if (second) {
      pages.value = second;
      return;
    }
    throw UNSTABLE;
  }

  async function initialPass(gen: number): Promise<void> {
    pages.value = [];
    await settle([1], [], gen);
  }

  async function refreshPass(gen: number, resumeFrom?: number): Promise<void> {
    const committed = pages.value;
    // 页集合为空（初次进入失败或权限收回清空）时刷新按初次读取执行，与 morePass 对称：
    // 否则刷新会空转成功，把「无权查看」冲成「该条件下没有活动」。
    if (!committed.length) return initialPass(gen);
    const numbers = committed.map((page) => page.page);
    if (resumeFrom !== undefined && resumeFrom > 1) {
      await settle(
        numbers.filter((number) => number >= resumeFrom),
        committed.filter((page) => page.page < resumeFrom),
        gen,
      );
      return;
    }
    await settle(numbers, [], gen);
  }

  async function morePass(gen: number, resumeFrom?: number): Promise<void> {
    const committed = pages.value;
    if (!committed.length) return initialPass(gen);
    const next = committed[committed.length - 1].page + 1;
    if (resumeFrom !== undefined && resumeFrom < next) {
      await settle(
        pageNumbers(resumeFrom, next),
        committed.filter((page) => page.page < resumeFrom),
        gen,
      );
      return;
    }
    await settle([next], committed, gen);
  }

  /**
   * 选中补读：从第 N+1 页升序取页，页预算为范围页数，四条早停。
   * 读到空页说明范围在读取期间收缩：按该页 total 截断页集合，不把它当作「还有下一页」；
   * 截断不成立时（已加载行越过新范围）整段重读，不提交旧页集合。
   */
  async function focusPass(activityId: string, gen: number): Promise<void> {
    const { item, slot } = options.selection();
    if (item !== activityId) return;
    if (slot !== undefined && outsideWindow(slot)) return;
    const committed = pages.value;
    if (committed.some((page) => page.items.some((row) => row.activity_id === activityId))) return;
    const budget = Math.max(1, Math.ceil((committed[0]?.total ?? 0) / options.pageSize));
    const collected = [...committed];
    let number = (committed[committed.length - 1]?.page ?? 0) + 1;
    let truncated: TimelineActivityPage[] | undefined;
    let shrunkTo: number | undefined;
    while (number <= budget) {
      const [page] = await readPages([number], gen);
      if (page.items.length === 0) {
        const limit = Math.max(1, Math.ceil(page.total / options.pageSize));
        shrunkTo = limit;
        truncated = consistent(
          collected
            .filter((row) => row.page <= limit)
            .map((row) => ({ ...row, total: page.total })),
        );
        break;
      }
      collected.push(page);
      if (page.items.some((row) => row.activity_id === activityId)) break;
      if (!(page.page * options.pageSize < page.total)) break;
      number += 1;
    }
    if (truncated) {
      pages.value = truncated;
      return;
    }
    // 空页说明范围在补读期间收缩。旧页集合按新 total 截断不成立（已加载行越过新范围）时，
    // 它自身仍「自洽」，提交它会把越界行报成成功；整段重读，由新快照判定。
    if (shrunkTo !== undefined) {
      const reread = consistent(await readPages(pageNumbers(1, shrunkTo), gen));
      if (reread) {
        pages.value = reread;
        return;
      }
      throw UNSTABLE;
    }
    const kept = consistent(collected);
    if (kept) {
      pages.value = kept;
      return;
    }
    const top = Math.max(...collected.map((page) => page.page));
    const second = consistent(await readPages(pageNumbers(1, top), gen));
    if (second) {
      pages.value = second;
      return;
    }
    throw UNSTABLE;
  }

  async function execute(
    intent: RangeIntent,
    resumeFrom: number | undefined,
    gen: number,
  ): Promise<RangeOutcome> {
    running.value = true;
    try {
      if (intent.kind === 'initial') await initialPass(gen);
      else if (intent.kind === 'refresh') await refreshPass(gen, resumeFrom);
      else if (intent.kind === 'more') await morePass(gen, resumeFrom);
      else if (intent.kind === 'focus') await focusPass(intent.activityId, gen);
      lastFailure = undefined;
      return { status: 'ok' };
    } catch (error) {
      if (error === ABORT) return { status: 'aborted' };
      if (error === UNSTABLE) {
        lastFailure = { intent, failedPage: 1 };
        return { status: 'unstable' };
      }
      const failedPage = error instanceof PageFailure ? error.page : 1;
      lastFailure = { intent, failedPage };
      if (error instanceof PageFailure && forbidden(error.reason)) {
        pages.value = [];
        return { status: 'failed', failedPage, forbidden: true };
      }
      return { status: 'failed', failedPage, forbidden: false };
    } finally {
      if (gen === generation) running.value = false;
    }
  }

  async function run(intent: RangeIntent): Promise<RangeOutcome> {
    let target = intent;
    let resumeFrom: number | undefined;
    if (intent.kind === 'retry') {
      if (!lastFailure) return { status: 'ok' };
      target = lastFailure.intent;
      resumeFrom = lastFailure.failedPage;
    }
    // 初次读取推进代际：旧轮在发起下一次请求前与每次响应后即刻停止。
    if (intent.kind === 'initial') cancel();
    // 代际在发起时定下，不在轮到执行时重取：排队期间被后续条件切换取代的轮次执行时直接中止。
    const gen = generation;
    const previous = active;
    // 先登记本轮再等前一轮：后到的 initial 排在本轮之后，不会与前一轮同时起跑。
    const pass = (async () => {
      if (previous) await previous;
      return execute(target, resumeFrom, gen);
    })();
    active = pass;
    try {
      return await pass;
    } finally {
      if (active === pass) active = undefined;
    }
  }

  /**
   * 推进代际，让在途轮次在发起下一次请求前或响应后停止。
   * 不清 `running`：条件切换后新轮还在等旧轮收尾，这段窗口里页面仍处于读取中，
   * 「加载更多」不能被放行（设计 §1.4：一轮进行中再次触发合并为一次待执行刷新）。
   */
  function cancel() {
    generation += 1;
  }

  function slotStart(key: string) {
    const parts = key.split('/');
    const start = parts.length === 3 ? Date.parse(parts[2]) : NaN;
    return Number.isFinite(start) ? start : undefined;
  }

  function outsideWindow(slot: string) {
    const start = slotStart(slot);
    if (start === undefined) return false;
    const { from, to } = options.window();
    const startOfWindow = Date.parse(from);
    const endOfWindow = Date.parse(to);
    if (!Number.isFinite(startOfWindow) || !Number.isFinite(endOfWindow)) return false;
    return start < startOfWindow || start >= endOfWindow;
  }

  const selection = computed<SelectionState>(() => {
    const { item, slot } = options.selection();
    if (!item) return { kind: 'none' };
    // 窗口判定先于活动查找：窗口外的时段键说明是窗口移动，活动是否已加载不改变这个结论（设计 §1.6）。
    if (slot !== undefined && outsideWindow(slot)) return { kind: 'window-moved' };
    const activity = rows.value.find((row) => row.activity_id === item);
    if (!activity || !activity.segments.length) return { kind: 'activity-missing' };
    if (slot === undefined) return { kind: 'kept', activity, slot: activity.segments[0] };
    const found = activity.segments.find((segment) => segment.occurrence_key === slot);
    return found ? { kind: 'kept', activity, slot: found } : { kind: 'schedule-updated' };
  });

  return {
    pages,
    rows,
    total,
    hasMore,
    evaluatedAt,
    running,
    selection,
    run,
    cancel,
  };
}

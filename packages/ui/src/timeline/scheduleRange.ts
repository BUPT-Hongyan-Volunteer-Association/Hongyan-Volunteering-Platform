import { computed, ref, shallowRef, type ComputedRef, type Ref, type ShallowRef } from 'vue';
import type { TimelineActivity, TimelineActivityPage, TimelineItem } from '@hongyan/contracts';

/** 一轮读取的意图：初次进入、刷新、加载更多、失败重试、按选中活动补读。 */
export type RangeIntent =
  | { kind: 'initial' }
  | { kind: 'refresh' }
  | { kind: 'more' }
  | { kind: 'retry' }
  | { kind: 'focus'; activityId: string };

/** 重试之外的一轮读取：重试沿用上一轮的意图与目标页号，不自成一类轮次。 */
type RoundIntent = Exclude<RangeIntent, { kind: 'retry' }>;

export type RangeOutcome =
  | { status: 'ok' }
  | { status: 'aborted' }
  | { status: 'failed'; forbidden: true }
  | { status: 'failed'; forbidden: false; failedPage: number }
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

/** 读页失败的事实：权限收回单独成项，普通失败取最小失败页号，两者互不覆盖。 */
type ReadFailure = { forbidden: true } | { forbidden: false; page: number };

class PageFailure extends Error {
  readonly failure: ReadFailure;

  constructor(failure: ReadFailure) {
    super('日程页读取失败');
    this.failure = failure;
  }
}

const forbidden = (cause: unknown) =>
  typeof cause === 'object' && cause !== null && (cause as { status?: number }).status === 403;

const pageNumbers = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);

/**
 * 按页号升序领取，最多 `maxInFlight` 个在途，返回前按页号升序排好——排序只在这一处。
 * 失败事实两个互相独立：任一页 403 记权限收回，其余失败取最小失败页号。
 */
async function readPages(
  numbers: number[],
  read: (page: number) => Promise<TimelineActivityPage>,
  maxInFlight: number,
): Promise<TimelineActivityPage[]> {
  const wanted = [...numbers];
  const results: TimelineActivityPage[] = [];
  let index = 0;
  let stopped = false;
  let revoked = false;
  let failedPage: number | undefined;
  const worker = async () => {
    while (!stopped && index < wanted.length) {
      const page = wanted[index];
      index += 1;
      try {
        results.push(await read(page));
      } catch (error) {
        stopped = true;
        if (error === ABORT) throw error;
        if (forbidden(error)) revoked = true;
        else if (failedPage === undefined || page < failedPage) failedPage = page;
        return;
      }
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(wanted.length, maxInFlight) }, worker),
  );
  if (settled.some((result) => result.status === 'rejected' && result.reason === ABORT))
    throw ABORT;
  if (revoked) throw new PageFailure({ forbidden: true });
  if (failedPage !== undefined) throw new PageFailure({ forbidden: false, page: failedPage });
  return results.sort((a, b) => a.page - b.page);
}

/**
 * 跨页一致性判据（设计 §1.3）：页号与页大小对齐、同页状态时刻一致、非末页满页、按
 * (activity_code, id) 严格递增、覆盖全集时活动数等于 total、已加载范围不超过覆盖所需页数。
 * 按给定顺序读，不再排序；不成立即 false——覆盖页数超出与空页都只作不成立信号，截断不是这里的事。
 */
function consistent(input: TimelineActivityPage[], pageSize: number): boolean {
  if (!input.length) return false;
  const expected = input[0].total;
  for (const [position, page] of input.entries()) {
    if (page.total !== expected) return false;
    if (page.page !== position + 1) return false;
    if (page.page_size !== pageSize) return false;
    if (!page.items.every((item) => item.state_evaluated_at === page.state_evaluated_at))
      return false;
    // partial 页只能出现在结果末页：还有后续页时本页必须是满页。
    if (page.page * pageSize < expected && page.items.length !== pageSize) return false;
  }
  const all = input.flatMap((page) => page.items);
  if (input.length * pageSize >= expected && all.length !== expected) return false;
  if (input.length > 1 && (input.length - 1) * pageSize >= expected) return false;
  for (let i = 1; i < all.length; i += 1) {
    const previous = all[i - 1];
    const current = all[i];
    if (previous.activity_code > current.activity_code) return false;
    if (previous.activity_code === current.activity_code && previous.activity_id >= current.activity_id)
      return false;
  }
  return true;
}

/** 第 2 页及以后读到空页：范围在读取期间收缩，按该页的 total 算出新的目标页号（设计 §1.6）。 */
function shrunkTarget(input: TimelineActivityPage[], pageSize: number): number | undefined {
  const empty = input.find((page) => page.page > 1 && page.items.length === 0);
  if (!empty) return undefined;
  return Math.max(1, Math.ceil(empty.total / pageSize));
}

/** 跨轮头部复核：`total` 与活动身份序列（各活动的 `activity_id` 顺序）与已提交的第 1 页一致（设计 §1.3）。 */
function sameHead(committed: TimelineActivityPage, fresh: TimelineActivityPage): boolean {
  return (
    committed.total === fresh.total &&
    committed.items.length === fresh.items.length &&
    committed.items.every((item, index) => item.activity_id === fresh.items[index].activity_id)
  );
}

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
  let lastFailure: { intent: RoundIntent; targetPage: number } | undefined;

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

  /** 本轮读页：代际固定在发起时刻，发起前与响应后各查一次（设计 §1.4）。 */
  const readerFor = (gen: number) => (page: number) => fetchPage(page, gen);

  /** 提交页集合受代际约束：旧轮即使已返回，也不得写入新代际（设计 §1.4）。 */
  function commit(next: TimelineActivityPage[], gen: number) {
    if (gen !== generation) throw ABORT;
    pages.value = next;
  }

  /** 本轮目标页号：初次读取到第 1 页、刷新到已加载末页、加载更多到下一页、补读到范围末页（设计 §1.5）。 */
  function roundTarget(intent: RoundIntent): number {
    const last = pages.value.at(-1)?.page ?? 0;
    if (intent.kind === 'initial') return 1;
    if (intent.kind === 'more') return last + 1;
    if (intent.kind === 'refresh') return Math.max(1, last);
    return Math.max(1, Math.ceil((pages.value[0]?.total ?? 0) / options.pageSize));
  }

  /**
   * 一条接受路径：候选页集合通过判据即提交；不成立（或已判不成立）就从第 1 页整段重读到
   * 本轮目标页号再判一次，一轮内最多两次整段读取（设计 §1.3、§1.6）。整段重读读到空页说明
   * 范围在读取期间收缩，目标页号按新 total 重算，下一次整段读取按新目标页号重来。两次仍不
   * 成立即未稳定。`rangeReads` = 本轮已花掉的整段读取次数：候选本身已是整段读取时传 1。
   */
  async function accept(
    candidate: TimelineActivityPage[] | undefined,
    targetPage: number,
    gen: number,
    rangeReads: number,
  ): Promise<void> {
    if (candidate && consistent(candidate, options.pageSize)) {
      commit(candidate, gen);
      return;
    }
    let target = targetPage;
    let used = rangeReads;
    while (used < 2) {
      used += 1;
      const reread = await readPages(pageNumbers(1, target), readerFor(gen), options.maxInFlight);
      if (consistent(reread, options.pageSize)) {
        commit(reread, gen);
        return;
      }
      target = shrunkTarget(reread, options.pageSize) ?? target;
    }
    throw UNSTABLE;
  }

  /** 初次读取：页集合与失败记录由 `run` 在发起时清空，这里只取第 1 页交给接受路径（候选即整段读取）。 */
  async function initialPass(gen: number): Promise<void> {
    await accept(await readPages([1], readerFor(gen), options.maxInFlight), 1, gen, 1);
  }

  /** 刷新：重读已加载的全部页号并整轮替换；页集合为空时按初次读取执行。 */
  async function refreshPass(gen: number): Promise<void> {
    const committed = pages.value;
    // 页集合为空（初次进入失败或权限收回清空）时刷新按初次读取执行，与 morePass 对称：
    // 否则刷新会空转成功，把「无权查看」冲成「该条件下没有活动」。
    if (!committed.length) return initialPass(gen);
    const numbers = committed.map((page) => page.page);
    const fresh = await readPages(numbers, readerFor(gen), options.maxInFlight);
    await accept(fresh, numbers[numbers.length - 1], gen, 1);
  }

  /**
   * 加载更多：先在闸门内重读第 1 页复核已加载范围的头部，通过后再取第 N+1 页；
   * 复核不一致即整段重读到 N+1。新页为空说明范围收缩，目标页号按该页 total 重算（设计 §1.3、§1.6）。
   */
  async function morePass(gen: number): Promise<void> {
    const committed = pages.value;
    if (!committed.length) return initialPass(gen);
    const next = committed[committed.length - 1].page + 1;
    const [head] = await readPages([1], readerFor(gen), options.maxInFlight);
    if (!sameHead(committed[0], head)) return accept(undefined, next, gen, 0);
    const [added] = await readPages([next], readerFor(gen), options.maxInFlight);
    const target = added.items.length
      ? next
      : Math.max(1, Math.ceil(added.total / options.pageSize));
    await accept([...committed, added], target, gen, 0);
  }

  /**
   * 选中补读：先复核头部，再从第 N+1 页升序取页，页预算为范围页数。找到所选活动即停，
   * 读到空页或范围耗尽也停；提交与整段重读都归接受路径（设计 §1.6）。
   */
  async function focusPass(activityId: string, gen: number): Promise<void> {
    const { item, slot } = options.selection();
    if (item !== activityId) return;
    // 早停只判「开始时刻不早于窗口结束」：开始时刻早于窗口首的分段仍可能与窗口相交（设计 §1.6）。
    if (slot !== undefined && pastWindowEnd(slot)) return;
    const committed = pages.value;
    if (committed.some((page) => page.items.some((row) => row.activity_id === activityId))) return;
    const [head] = await readPages([1], readerFor(gen), options.maxInFlight);
    const budget = Math.max(1, Math.ceil(head.total / options.pageSize));
    // 没有已提交的头部可比时按不一致处置：整段重读到范围末页。
    if (!committed.length || !sameHead(committed[0], head)) return accept(undefined, budget, gen, 0);
    const collected = [...committed];
    let number = committed[committed.length - 1].page + 1;
    let target = budget;
    while (number <= budget) {
      const [page] = await readPages([number], readerFor(gen), options.maxInFlight);
      collected.push(page);
      if (page.items.length === 0) {
        target = Math.max(1, Math.ceil(page.total / options.pageSize));
        break;
      }
      if (page.items.some((row) => row.activity_id === activityId)) break;
      if (!(page.page * options.pageSize < page.total)) break;
      number += 1;
    }
    await accept(collected, target, gen, 0);
  }

  async function execute(
    intent: RoundIntent,
    retryTarget: number | undefined,
    gen: number,
  ): Promise<RangeOutcome> {
    running.value = true;
    const targetPage = retryTarget ?? roundTarget(intent);
    try {
      // 重试 = 从第 1 页整段重读到本轮目标页号，不与上一次显示的页拼接（设计 §1.5）。
      if (retryTarget !== undefined) await accept(undefined, targetPage, gen, 0);
      else if (intent.kind === 'initial') await initialPass(gen);
      else if (intent.kind === 'refresh') await refreshPass(gen);
      else if (intent.kind === 'more') await morePass(gen);
      else await focusPass(intent.activityId, gen);
      lastFailure = undefined;
      return { status: 'ok' };
    } catch (error) {
      // 代际已变：这一轮的响应不得写入新代际，失败记录也不留（设计 §1.4）。
      if (error === ABORT || gen !== generation) return { status: 'aborted' };
      lastFailure = { intent, targetPage };
      if (error === UNSTABLE) return { status: 'unstable' };
      // 读页之外的意外错误按第 1 页的普通失败上报：它没有页号事实，也不掩盖权限收回。
      const failure: ReadFailure =
        error instanceof PageFailure ? error.failure : { forbidden: false, page: 1 };
      if (!failure.forbidden)
        return { status: 'failed', forbidden: false, failedPage: failure.page };
      // 403 不留重试目标与旧结果：重新读取走初次读取（设计 §1.5）。
      pages.value = [];
      lastFailure = undefined;
      return { status: 'failed', forbidden: true };
    } finally {
      if (gen === generation) running.value = false;
    }
  }

  async function run(intent: RangeIntent): Promise<RangeOutcome> {
    let target: RoundIntent;
    let retryTarget: number | undefined;
    if (intent.kind === 'retry') {
      // 重试不看失败页号：起点由上一轮的目标页号决定（设计 §1.5）。
      // 没有失败记录就没有可重试的目标：这一轮什么都没读，按「没有发生」上报，页面不动文案与选中。
      if (!lastFailure) return { status: 'aborted' };
      target = lastFailure.intent;
      retryTarget = lastFailure.targetPage;
    } else target = intent;
    // 初次读取在发起的那一刻推进代际并清空页集合与失败记录，不等在途轮次收尾（设计 §1.2）。
    if (intent.kind === 'initial') {
      cancel();
      pages.value = [];
      lastFailure = undefined;
    }
    // 代际在发起时定下，不在轮到执行时重取：排队期间被后续条件切换取代的轮次执行时直接中止。
    const gen = generation;
    const previous = active;
    // 先登记本轮再等前一轮：后到的 initial 排在本轮之后，不会与前一轮同时起跑。
    const pass = (async () => {
      if (previous) await previous;
      return execute(target, retryTarget, gen);
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

  /** 时段键的开始时刻与窗口首尾，一处取好给两条窗内／窗外判据共用。 */
  function windowBounds(key: string) {
    const parts = key.split('/');
    const start = parts.length === 3 ? Date.parse(parts[2]) : NaN;
    const { from, to } = options.window();
    const fromAt = Date.parse(from);
    const toAt = Date.parse(to);
    // 取不到时刻时按「在窗内」处置：错判成窗外的代价是把仍在结果里的时段说成已移出（§2.2 三种说明全误报），错判成窗内只走正常分支。
    if (!Number.isFinite(start) || !Number.isFinite(fromAt) || !Number.isFinite(toAt)) return;
    return { start, fromAt, toAt };
  }

  /** 窗口判定：开始时刻早于窗口首，或落在窗口结束及以后（设计 §2.2 第 2 种）。 */
  function outsideWindow(slot: string) {
    const bounds = windowBounds(slot);
    return !!bounds && (bounds.start < bounds.fromAt || bounds.start >= bounds.toAt);
  }

  /** 补读早停只判窗口结束：开始时刻早于窗口首的分段仍可能与窗口相交（设计 §1.6）。 */
  function pastWindowEnd(slot: string) {
    const bounds = windowBounds(slot);
    return !!bounds && bounds.start >= bounds.toAt;
  }

  const selection = computed<SelectionState>(() => {
    const { item, slot } = options.selection();
    if (!item) return { kind: 'none' };
    const activity = rows.value.find((row) => row.activity_id === item);
    // 匹配先于窗口判定：服务端只返回与窗口相交的分段，跨午夜段的键同样在响应里（设计 §2.2）。
    const found =
      slot === undefined
        ? activity?.segments[0]
        : activity?.segments.find((segment) => segment.occurrence_key === slot);
    if (activity && found) return { kind: 'kept', activity, slot: found };
    if (slot !== undefined && outsideWindow(slot)) return { kind: 'window-moved' };
    if (!activity || !activity.segments.length) return { kind: 'activity-missing' };
    return { kind: 'schedule-updated' };
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

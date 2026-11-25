import { computed, ref, shallowRef } from 'vue';
import type { TimelineActivity, TimelineActivityPage } from '@hongyan/contracts';

type Page = TimelineActivityPage & { rangeKey: string };

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
  | { status: 'failed'; forbidden: false; failedPage: number; message: string }
  | { status: 'unstable' };

export type SelectionState =
  | { kind: 'none' }
  | { kind: 'kept'; activity: TimelineActivity }
  | { kind: 'activity-missing' };

export interface RangeOptions {
  /** 同时在途的日程请求上限，必填且无默认值。 */
  maxInFlight: number;
  /** 页大小，与服务端请求一致。 */
  pageSize: number;
  selectedId: () => string | undefined;
}

const ABORT = Symbol('schedule-range-abort');

const forbidden = (e: unknown) =>
  typeof e === 'object' && e !== null && 'status' in e && e.status === 403;

const pageCount = (page: Page) => Math.max(1, Math.ceil(page.total / page.page_size));

function consistent(pages: Page[], size: number) {
  const first = pages[0];
  let previous: TimelineActivity | undefined;
  return pages.every((page, index) => {
    const expectedCount = Math.min(size, Math.max(0, first.total - index * size));
    if (
      !Number.isFinite(Date.parse(page.state_evaluated_at)) ||
      page.rangeKey !== first.rangeKey || page.total !== first.total ||
      page.page !== index + 1 || page.page_size !== size || page.items.length !== expectedCount
    ) return false;
    for (const item of page.items) {
      if (previous && (
        previous.activity_code > item.activity_code ||
        (previous.activity_code === item.activity_code && previous.activity_id >= item.activity_id)
      )) return false;
      previous = item;
    }
    return true;
  });
}

export function createScheduleRange(read: (page: number) => Promise<Page>, options: RangeOptions) {
  const { pageSize, maxInFlight } = options;
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || !Number.isInteger(pageSize) || pageSize < 1)
    throw new RangeError('页大小与并发数须为正整数');
  const pages = shallowRef<Page[]>([]);
  const running = ref(false);
  const rows = computed(() => pages.value.flatMap((page) => page.items));
  const total = computed(() => pages.value[0]?.total ?? 0);
  const hasMore = computed(() => pages.value.length * pageSize < total.value);
  const evaluatedAt = computed(() => pages.value[0]?.state_evaluated_at ?? '');
  let generation = 0;
  let active: Promise<RangeOutcome> | undefined;
  let failed: RoundIntent | undefined;

  async function execute(intent: RoundIntent, retry: boolean, gen: number): Promise<RangeOutcome> {
    if (gen !== generation) return { status: 'aborted' };
    const previous = pages.value;
    const target = Math.max(1, previous.length + (intent.kind === 'more' ? 1 : 0));
    running.value = true;
    let failure: { page: number; message: string } | undefined;
    let revoked = false;
    const readOne = async (number: number) => {
      if (gen !== generation) throw ABORT;
      try {
        const page = await read(number);
        if (gen !== generation) throw ABORT;
        return page;
      } catch (e) {
        if (gen !== generation) throw ABORT;
        if (!failure || number < failure.page)
          failure = { page: number, message: e instanceof Error ? e.message : '读取活动日程失败' };
        if (forbidden(e)) {
          revoked = true;
          pages.value = [];
        }
        throw e;
      }
    };
    // 所有轮次串行。同一轮内按页号领取，失败后等待已在途的页，以便权限收回优先。
    const readRange = async (last: number) => {
      const result: Page[] = [];
      let next = 1;
      const worker = async () => {
        while (next <= last && !failure) {
          const number = next++;
          result[number - 1] = await readOne(number);
        }
      };
      const workers = await Promise.allSettled(Array.from({ length: Math.min(last, maxInFlight) }, worker));
      const error = workers.find((worker) => worker.status === 'rejected');
      if (error?.status === 'rejected') throw error.reason;
      return result;
    };

    try {
      let last = target;
      for (let attempt = 0; attempt < 2; attempt++) {
        // 有全范围摘要时可以复用前页；校验失败或重试时从头读取。
        const reuse = !retry && attempt === 0 && previous.length > 0;
        let candidate: Page[];
        if (intent.kind === 'focus') {
          const item = options.selectedId();
          if (item !== intent.activityId)
            return { status: 'ok' };
          candidate = reuse ? [...previous] : [await readOne(1)];
          const containsItem = (page: Page) => page.items.some((row) => row.activity_id === item);
          if (!candidate.some(containsItem)) {
            while (candidate.length < pageCount(candidate[0])) {
              const next = await readOne(candidate.length + 1);
              candidate.push(next);
              if (next.rangeKey !== candidate[0].rangeKey || !next.items.length || containsItem(next)) break;
            }
          }
        } else if (intent.kind === 'more' && reuse) {
          candidate = [...previous, await readOne(last)];
        } else {
          candidate = await readRange(last);
        }
        if (gen !== generation) throw ABORT;
        if (consistent(candidate, pageSize)) {
          pages.value = candidate.slice(0, pageCount(candidate[0]));
          failed = undefined;
          return { status: 'ok' };
        }
        last = Math.min(target, pageCount(candidate[candidate.length - 1]));
      }
      failed = intent;
      return { status: 'unstable' };
    } catch (e) {
      if (e === ABORT || gen !== generation) return { status: 'aborted' };
      failed = revoked ? undefined : intent;
      if (revoked) return { status: 'failed', forbidden: true };
      if (!failure) throw e;
      return { status: 'failed', forbidden: false, failedPage: failure.page, message: failure.message };
    } finally {
      if (gen === generation) running.value = false;
    }
  }

  function cancel() { generation++; }
  async function run(intent: RangeIntent): Promise<RangeOutcome> {
    if (intent.kind === 'initial') {
      cancel();
      pages.value = [];
      failed = undefined;
    }
    const target = intent.kind === 'retry' ? failed : intent;
    if (!target) return { status: 'aborted' };
    const gen = generation;
    const previous = active;
    const pass = previous
      ? previous.then(() => execute(target, intent.kind === 'retry', gen))
      : execute(target, intent.kind === 'retry', gen);
    active = pass;
    try {
      return await pass;
    } finally {
      if (active === pass) active = undefined;
    }
  }

  const selection = computed<SelectionState>(() => {
    const id = options.selectedId();
    if (!id) return { kind: 'none' };
    const activity = rows.value.find(row => row.activity_id === id);
    return activity ? { kind: 'kept', activity } : { kind: 'activity-missing' };
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

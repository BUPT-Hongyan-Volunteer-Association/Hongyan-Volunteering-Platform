import type { ActivityInput, ActivityPublicationContent } from '@hongyan/contracts/types';
import { activeRegistrationStatuses, activityBounds } from '@hongyan/contracts/activity';
import type { Tx } from '../database.js';
import { BusinessError, invalid } from '../http.js';
import { checkSelections, registrationInventory, wholeItemId } from '../registrations/enrollment.js';

function checkIds(entries: { id: string }[], field: string) {
  const seen = new Set<string>();
  for (const [i, entry] of entries.entries()) {
    entry.id = entry.id.toLowerCase();
    if (seen.has(entry.id)) invalid(field + '.' + i + '.id', '同一列表的标识不能重复');
    seen.add(entry.id);
  }
}

/** 草稿与发布使用同一份归一化配置，分批模式的总名额由服务端计算。 */
export function prepareRecruitment(a: ActivityInput, publication: boolean) {
  a.registration_mode ??= 'whole';
  a.waitlist_capacity ??= 0;
  const questions = a.questions ?? [];
  checkIds(questions, 'questions');
  for (const [i, q] of questions.entries()) {
    const field = 'questions.' + i;
    q.title = q.title.trim();
    if (publication && !q.title) invalid(field + '.title', '请填写题目');
    const options = q.options ?? [];
    checkIds(options, field + '.options');
    if (q.type === 'text') {
      if (options.length) invalid(field + '.options', '填空题不能设置选项');
    } else {
      if (publication && options.length < 2) invalid(field + '.options', '选择题至少需要两个选项');
      const labels = new Set<string>();
      for (const [j, option] of options.entries()) {
        option.label = option.label.trim();
        if (publication && (!option.label || labels.has(option.label)))
          invalid(field + '.options.' + j + '.label', '请填写互不重复的选项');
        labels.add(option.label);
      }
    }
  }
  if (a.registration_mode === 'whole') {
    if ((a.capacity ?? 0) > 10000) invalid('capacity', '计划名额最多为 10000 人');
    if (a.waitlist_capacity > 10000) invalid('waitlist_capacity', '候补人数最多为 10000 人');
    delete a.registration_items;
    delete a.allow_multiple_roles;
    delete a.allow_multiple_slots;
    return;
  }
  const items = a.registration_items ?? [];
  checkIds(items, 'registration_items');
  if (publication && !items.length) invalid('registration_items', '请添加至少一个报名项');
  const bounds = activityBounds(a.schedule);
  const choices = new Set<string>();
  for (const [i, item] of items.entries()) {
    const field = 'registration_items.' + i;
    if (item.id === wholeItemId) invalid(field + '.id', '报名项标识无效');
    item.role = item.role?.trim() || undefined;
    if (publication && !item.role && !item.starts_at) invalid(field, '请填写岗位或服务时段');
    if (publication && !!item.starts_at !== !!item.ends_at) invalid(field, '请补齐服务起止时刻');
    const start = item.starts_at && Date.parse(item.starts_at);
    const end = item.ends_at && Date.parse(item.ends_at);
    if (typeof start === 'number' && typeof end === 'number') {
      if (start >= end) invalid(field + '.ends_at', '结束时刻必须晚于开始时刻');
      if (bounds && (start < bounds.start || end > bounds.end))
        invalid(field, '服务时段必须落在活动总日期内');
    }
    const identity = JSON.stringify([item.role ?? '', start, end]);
    if (publication && choices.has(identity)) invalid(field, '已存在相同岗位和时段的报名项');
    choices.add(identity);
  }
  if (items.length) {
    a.capacity = items.reduce((sum, item) => sum + item.capacity, 0);
    a.waitlist_capacity = items.reduce((sum, item) => sum + item.waitlist_capacity, 0);
  } else {
    delete a.capacity;
    a.waitlist_capacity = 0;
  }
}

export async function checkRecruitmentRevision(
  tx: Tx, activityId: string, old: ActivityPublicationContent | undefined, next: ActivityPublicationContent,
) {
  if (!old) return;
  const used = await tx.registration.findMany({
    where: { activity_id: activityId }, distinct: ['item_id'], select: { item_id: true },
  });
  if (!used.length) return;
  const conflict = (message: string): never => { throw new BusinessError(409, 'capacity_conflict', message); };
  if ((old.registration_mode ?? 'whole') !== (next.registration_mode ?? 'whole'))
    conflict('已有报名记录，无法更换报名模式');
  const previousItems = new Map(old.registration_items?.map(item => [item.id, item]));
  const nextItems = new Map(next.registration_items?.map(item => [item.id, item]));
  for (const { item_id } of used) {
    if (item_id === wholeItemId) continue;
    const before = previousItems.get(item_id), after = nextItems.get(item_id);
    const instant = (value?: string) => value ? Date.parse(value) : null;
    if (!before || !after || before.role !== after.role ||
      instant(before.starts_at) !== instant(after.starts_at) || instant(before.ends_at) !== instant(after.ends_at))
      conflict('已有报名记录的岗位和时段须保留，可新增其他报名项');
  }
  if ((old.allow_multiple_roles && !next.allow_multiple_roles) || (old.allow_multiple_slots && !next.allow_multiple_slots)) {
    const active = await tx.registration.findMany({ where: { activity_id: activityId, status: { in: activeRegistrationStatuses } },
      select: { student_id: true, item_id: true } });
    const selections = new Map<string, string[]>();
    for (const row of active) {
      const selected = selections.get(row.student_id) ?? [];
      selected.push(row.item_id);
      selections.set(row.student_id, selected);
    }
    for (const ids of selections.values()) checkSelections(next, ids);
  }
  const inventory = await registrationInventory(tx, activityId, next);
  for (const row of inventory) {
    if (row.accepted_count > row.capacity || row.waitlisted_count > row.waitlist_capacity ||
      row.active_count > row.capacity + row.waitlist_capacity)
      conflict(row.item_label + '的名额不能少于当前已占人数');
  }
}

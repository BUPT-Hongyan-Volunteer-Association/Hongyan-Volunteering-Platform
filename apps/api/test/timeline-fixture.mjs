const day = 86_400_000;

/**
 * 独立库里的日程演示数据：一项当天正在进行的活动，和一项跨两天、共三段的多时段活动。
 * 日期按运行时刻推导，页面回归直接从返回值取窗口，不再依赖写死的示例日期。
 */
export async function createScheduleDemo(db) {
  const first = await db.activity.findUniqueOrThrow({
    where: { activity_code: 'P2026-0001' },
    include: { revisions: true },
  });
  const template = first.revisions[0].content;
  // 由另一位负责人管理，避免改变首位负责人的管理列表分页预期。
  const owner = await db.account.findUniqueOrThrow({ where: { username: '0000000003' } });
  const ownerId = owner.id;
  const beijing = new Date(Date.now() + 8 * 3600_000);
  const dateAt = (offset) =>
    new Date(beijing.getTime() + offset * day).toISOString().slice(0, 10);
  // 锚点固定为下一个周三，前一天为周二，两者必在同一自然周内。
  const toWednesday = (3 - beijing.getUTCDay() + 7) % 7;
  const anchorOffset = toWednesday < 3 ? toWednesday + 7 : toWednesday;
  const anchor = dateAt(anchorOffset);
  const before = dateAt(anchorOffset - 1);
  const at = (date, time) => date + 'T' + time + ':00+08:00';
  const create = (code, title, schedule) =>
    db.activity.create({
      data: {
        activity_code: code,
        status: 'published',
        working_revision: 1,
        published_revision: 1,
        members: { create: { account_id: ownerId, member_role: 'owner' } },
        revisions: {
          create: {
            revision: 1,
            revision_state: 'approved',
            approved_at: new Date(),
            created_by: ownerId,
            content: { ...template, title, schedule },
          },
        },
      },
    });
  const multi = await create('TL-9001', '校园服务丙', {
    schedule_type: 'custom',
    duration_start_date: before,
    duration_end_date: anchor,
    slots: [
      { starts_at: at(before, '09:15'), ends_at: at(before, '11:30') },
      { starts_at: at(anchor, '09:30'), ends_at: at(anchor, '10:45') },
      { starts_at: at(anchor, '14:15'), ends_at: at(anchor, '15:45') },
    ],
  });
  const ongoing = await create('TL-9002', '正在进行演示', {
    schedule_type: 'continuous',
    starts_at: new Date(Date.now() - 3600_000).toISOString(),
    ends_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  return { multi, ongoing, anchor, before, at };
}

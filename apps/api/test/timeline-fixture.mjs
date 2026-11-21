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
  // 分页演示：同一天 21 项，前 20 项归活动协作者，第 21 项归乙负责人，用于核对追加与候选。
  const firstOwner = await db.account.findUniqueOrThrow({ where: { username: '0000000004' } });
  const lastOwner = await db.account.findUniqueOrThrow({ where: { username: '0000000003' } });
  const paged = dateAt(anchorOffset + 35);
  const pagedItems = [];
  for (let index = 1; index <= 21; index++) {
    const code = 'TL-92' + String(index).padStart(2, '0');
    const account = index === 21 ? lastOwner : firstOwner;
    const row = await db.activity.create({
      data: {
        activity_code: code,
        status: 'published',
        working_revision: 1,
        published_revision: 1,
        members: { create: { account_id: account.id, member_role: 'owner' } },
        revisions: {
          create: {
            revision: 1,
            revision_state: 'approved',
            approved_at: new Date(),
            created_by: account.id,
            content: {
              ...template,
              title: '分页演示 ' + String(index).padStart(2, '0'),
              schedule: {
                schedule_type: 'continuous',
                starts_at: at(paged, '10:00'),
                ends_at: at(paged, '12:00'),
              },
            },
          },
        },
      },
    });
    pagedItems.push(row);
  }
  return {
    multi,
    ongoing,
    anchor,
    before,
    paged,
    pagedLast: pagedItems[pagedItems.length - 1],
    pagedOwner: lastOwner,
  };
}

const day = 86_400_000;

export const atTime = (date, time) => date + 'T' + time + ':00+08:00';

/**
 * 独立编号前缀与独立日期窗口的日程数据集：同日同时段、按编号升序，正好 `count` 项。
 * 一次写入活动、版本与负责人，深分页的 1001 项也能在数秒内就绪。
 */
export async function createScheduleDataset(
  db,
  { codePrefix, titlePrefix, date, count, ownerUsername = '0000000003' },
) {
  const source = await db.activity.findUniqueOrThrow({ where: { activity_code: 'P2026-0001' } });
  const template = (
    await db.activityRevision.findFirstOrThrow({
      where: { activity_id: source.id, revision: 1 },
    })
  ).content;
  const owner = await db.account.findUniqueOrThrow({ where: { username: ownerUsername } });
  const width = String(count).length;
  const codes = Array.from(
    { length: count },
    (_, index) => codePrefix + String(index + 1).padStart(width, '0'),
  );
  const schedule = {
    schedule_type: 'continuous',
    starts_at: atTime(date, '10:00'),
    ends_at: atTime(date, '12:00'),
  };
  await db.activity.createMany({
    data: codes.map((activity_code) => ({
      activity_code,
      status: 'published',
      working_revision: 1,
      published_revision: 1,
    })),
  });
  const rows = await db.activity.findMany({
    where: { activity_code: { in: codes } },
    select: { id: true, activity_code: true },
  });
  const ids = new Map(rows.map((row) => [row.activity_code, row.id]));
  await db.activityRevision.createMany({
    data: codes.map((code) => ({
      activity_id: ids.get(code),
      revision: 1,
      revision_state: 'approved',
      approved_at: new Date(),
      created_by: owner.id,
      content: { ...template, title: titlePrefix + ' ' + code.slice(codePrefix.length), schedule },
    })),
  });
  await db.activityMember.createMany({
    data: rows.map((row) => ({
      activity_id: row.id,
      account_id: owner.id,
      member_role: 'owner',
    })),
  });
  return { date, codePrefix, codes, count };
}

/** 报名关系预置：直接写关系表，绕开尚未合入的真实报名入口。 */
export async function presetRegistration(db, { activityCode, studentNo, status }) {
  const student = await db.student.findUniqueOrThrow({ where: { student_no: studentNo } });
  const activity = await db.activity.findUniqueOrThrow({ where: { activity_code: activityCode } });
  return db.registration.upsert({
    where: { activity_id_student_id: { activity_id: activity.id, student_id: student.id } },
    update: { status },
    create: { activity_id: activity.id, student_id: student.id, status },
  });
}

/** 交接预置：把负责人关系挂到单项活动上，或把它摘掉。 */
export async function setActivityOwner(db, { activityCode, username, attached = true }) {
  const account = await db.account.findUniqueOrThrow({ where: { username } });
  const activity = await db.activity.findUniqueOrThrow({ where: { activity_code: activityCode } });
  const key = { activity_id_account_id: { activity_id: activity.id, account_id: account.id } };
  if (!attached)
    return db.activityMember.deleteMany({
      where: { activity_id: activity.id, account_id: account.id },
    });
  return db.activityMember.upsert({
    where: key,
    update: {},
    create: { activity_id: activity.id, account_id: account.id, member_role: 'owner' },
  });
}

/**
 * 独立库里的日程演示数据：一项当天正在进行的活动、一项跨两天共三段的多时段活动，
 * 以及 41 项分页演示数据（`TL-9201`–`TL-9241`，第 21 项归首位负责人）。
 * 日期按运行时刻推导，页面回归直接从返回值取窗口，不再依赖写死的示例日期。
 */
export async function createScheduleDemo(db) {
  const first = await db.activity.findUniqueOrThrow({ where: { activity_code: 'P2026-0001' } });
  const template = (
    await db.activityRevision.findFirstOrThrow({
      where: { activity_id: first.id, revision: 1 },
    })
  ).content;
  // 由另一位负责人管理，避免改变首位负责人的管理列表分页预期。
  const owner = await db.account.findUniqueOrThrow({ where: { username: '0000000003' } });
  const beijing = new Date(Date.now() + 8 * 3600_000);
  const dateAt = (offset) =>
    new Date(beijing.getTime() + offset * day).toISOString().slice(0, 10);
  // 锚点固定为下一个周三，前一天为周二，两者必在同一自然周内。
  const toWednesday = (3 - beijing.getUTCDay() + 7) % 7;
  const anchorOffset = toWednesday < 3 ? toWednesday + 7 : toWednesday;
  const anchor = dateAt(anchorOffset);
  const before = dateAt(anchorOffset - 1);
  const at = (date, time) => date + 'T' + time + ':00+08:00';
  const create = (code, title, schedule, ownerId = owner.id) =>
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
  await create('TL-9001', '校园服务丙', {
    schedule_type: 'custom',
    duration_start_date: before,
    duration_end_date: anchor,
    slots: [
      { starts_at: at(before, '09:15'), ends_at: at(before, '11:30') },
      { starts_at: at(anchor, '09:30'), ends_at: at(anchor, '10:45') },
      { starts_at: at(anchor, '14:15'), ends_at: at(anchor, '15:45') },
    ],
  });
  await create('TL-9002', '正在进行演示', {
    schedule_type: 'continuous',
    starts_at: new Date(Date.now() - 3600_000).toISOString(),
    ends_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  // 第 21 项是乙负责人唯一的分页样例，目标在第 2 页，后面还有第 3 页。
  const other = await db.account.findUniqueOrThrow({ where: { username: '0000000004' } });
  const paged = dateAt(anchorOffset + 35);
  const schedule = { schedule_type: 'continuous', starts_at: at(paged, '10:00'), ends_at: at(paged, '12:00') };
  for (let index = 1; index <= 41; index++) {
    const number = String(index).padStart(2, '0');
    await create('TL-92' + number, '分页演示 ' + number, schedule, index === 21 ? owner.id : other.id);
  }
  return { anchor, before, paged, pagedOwner: owner };
}

/**
 * 同一项每周活动的获批版 A 与待审版 B：A 是当日的两条例行时段；
 * B 排除原日期取消当日例行时段，再用补充时段补办 16:15，展开后只剩这一段。
 * 两版挂在同一项活动上，驳回与批准各能观察到一版。
 */
export async function createWeeklyRevisionPair(db, { activityCode, title, date, ownerUsername }) {
  const source = await db.activity.findUniqueOrThrow({ where: { activity_code: 'P2026-0001' } });
  const template = (
    await db.activityRevision.findFirstOrThrow({
      where: { activity_id: source.id, revision: 1 },
    })
  ).content;
  const owner = await db.account.findUniqueOrThrow({ where: { username: ownerUsername } });
  // 服务端按本地日期的 ISO 星期展开周规则：周一为 1，周日为 7。
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay() || 7;
  const rule = (start_time, end_time) => ({
    weekday,
    start_time,
    end_time,
    end_day_offset: 0,
  });
  const approved = {
    schedule_type: 'weekly',
    duration_start_date: date,
    duration_end_date: date,
    weekly_slots: [rule('09:30', '10:45'), rule('14:15', '15:45')],
  };
  const pending = {
    ...approved,
    excluded_dates: [date],
    additional_slots: [{ starts_at: atTime(date, '16:15'), ends_at: atTime(date, '17:15') }],
  };
  const activity = await db.activity.create({
    data: {
      activity_code: activityCode,
      status: 'published',
      working_revision: 2,
      published_revision: 1,
      members: { create: { account_id: owner.id, member_role: 'owner' } },
      revisions: {
        create: [
          {
            revision: 1,
            revision_state: 'approved',
            approved_at: new Date(),
            created_by: owner.id,
            content: { ...template, title, schedule: approved },
          },
          {
            revision: 2,
            revision_state: 'pending_review',
            created_by: owner.id,
            content: { ...template, title, schedule: pending },
          },
        ],
      },
    },
  });
  await db.activityReview.create({
    data: { activity_id: activity.id, revision: 2, previous_revision: 1, submitted_by: owner.id },
  });
  return { activity, approved, pending };
}


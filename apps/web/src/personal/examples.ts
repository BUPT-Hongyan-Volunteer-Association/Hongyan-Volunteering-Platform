import type { Appeal, HourRecord, Incident, Notice } from '@hongyan/contracts';
import type { PreviewRecord } from '@hongyan/ui/preview';

export const title = '图书馆志愿服务';
export const activityId = '71000000-0000-4000-8000-000000000001';
const student = '71000000-0000-4000-8000-000000000002';
const common = { version: 1, student_id: student, activity_id: activityId };
const notices: Notice[] = [
  { title: '集合地点调整', notice_kind: 'change', body: '11 月 21 日请到一层服务台集合。' },
  {
    title: '时长审核结果',
    notice_kind: 'hours_result',
    body: '11 月 14 日的服务已核定 2.0 小时。',
    read_at: '2026-11-16T11:00:00+08:00',
  },
  {
    title: '录取结果',
    notice_kind: 'result',
    body: '你的整项活动报名已录取。',
    read_at: '2026-11-11T11:01:00+08:00',
    acknowledged_at: '2026-11-11T11:05:00+08:00',
  },
].map((n, i) => ({
  ...n,
  notice_kind: n.notice_kind as Notice['notice_kind'],
  id: '71000000-0000-4000-8000-00000000001' + i,
  activity_id: activityId,
  version: 1,
  information_version: 1,
  requires_ack: i !== 1,
  is_current: true,
  published_at: ['2026-11-17', '2026-11-16', '2026-11-11'][i] + 'T10:00:00+08:00',
}));
const hour: HourRecord = {
  ...common,
  id: '71000000-0000-4000-8000-000000000020',
  activity_code: 'P2026-0021',
  activity_title: title,
  service_date: '2026-11-14',
  credited_hours: '2.0',
  status: 'current',
  origin_schedule_revision: 1,
  batch_id: '71000000-0000-4000-8000-000000000021',
};
const incident: Incident = {
  ...common,
  id: '71000000-0000-4000-8000-000000000022',
  facts: '11 月 14 日迟到十分钟',
  service_date: hour.service_date,
  status: 'confirmed',
  submitted_by: '71000000-0000-4000-8000-000000000023',
  review_reason: '已核对签到记录',
};
const appeal: Appeal = {
  ...common,
  id: '71000000-0000-4000-8000-000000000024',
  target_type: 'missing_hours',
  status: 'in_review',
  service_date: '2026-11-15',
  description: '协助整理归还书籍，反馈当日时长漏记。',
};
const incidentAppeal: Appeal = {
  ...common,
  id: '71000000-0000-4000-8000-000000000025',
  target_id: incident.id,
  target_type: 'incident',
  description: '本人已提前联系负责人，请复核签到说明。',
  status: 'pending',
};
export const totalHours = hour.credited_hours;
export const personalRecords: Record<'notices' | 'hours' | 'feedback', PreviewRecord[]> = {
  notices: notices.map((n) => ({
    id: n.id,
    title: n.title,
    status: n.acknowledged_at ? '已确认' : n.read_at ? '已读' : '未读',
    fields: [
      ['所属活动', title],
      ['发布日期', n.published_at.slice(0, 10)],
      ['通知内容', n.body],
    ],
  })),
  hours: [
    {
      id: hour.id,
      title,
      status: hour.credited_hours + ' 小时',
      fields: [
        ['服务日期', hour.service_date],
        ['认证时长', hour.credited_hours + ' 小时'],
        ['记录状态', '当前有效'],
        ['活动编号', hour.activity_code],
      ],
    },
  ],
  feedback: [
    {
      id: incident.id,
      title: '已确认异常',
      status: '已核实',
      fields: [
        ['活动', title],
        ['事实', incident.facts],
        ['核实意见', incident.review_reason!],
        ['本人可见附件', '暂无已发布的脱敏副本'],
        ['处罚', '未启用'],
      ],
    },
    {
      id: incidentAppeal.id,
      title: '异常申诉',
      status: '待受理',
      fields: [
        ['申请编号', 'A2026-014'],
        ['关联事实', incident.facts],
        ['本人说明', incidentAppeal.description],
        ['办理进度', '已提交，等待老师核查'],
      ],
    },
    {
      id: appeal.id,
      title: '漏记反馈',
      status: '处理中',
      fields: [
        ['活动', title],
        ['服务日期', appeal.service_date!],
        ['本人说明', appeal.description],
      ],
    },
  ],
};

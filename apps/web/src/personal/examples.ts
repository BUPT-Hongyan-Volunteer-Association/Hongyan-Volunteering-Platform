import type { Appeal, HourRecord, Incident } from '@hongyan/contracts';
import type { PreviewRecord } from '@hongyan/ui/preview';

export const title = '图书馆志愿服务';
export const activityId = '71000000-0000-4000-8000-000000000001';
const student = '71000000-0000-4000-8000-000000000002';
const common = { version: 1, student_id: student, activity_id: activityId };
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
export const personalRecords: Record<'hours' | 'feedback', PreviewRecord[]> = {
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

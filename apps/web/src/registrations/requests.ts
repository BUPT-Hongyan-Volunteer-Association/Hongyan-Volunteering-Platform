import type { PreviewRecord } from '@hongyan/ui/preview';
export const requests: PreviewRecord[] = [
  { id: 'exit-01', title: '周同学 · 退出申请', status: '待处理', fields: [['报名关系', 'R-012'], ['申请时间', '11 月 17 日 14:00'], ['申请原因', '后续课程时间冲突'], ['当前名额', '审核通过后释放']] },
  { id: 'restore-01', title: '林同学 · 恢复申请', status: '已批准', fields: [['原报名关系', 'R-018'], ['申请原因', '可以参加后续尚未开始的时段'], ['处理结果', '沿用原报名，恢复已录取状态']] },
];

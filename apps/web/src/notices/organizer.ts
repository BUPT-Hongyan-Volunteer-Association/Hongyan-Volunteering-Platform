import type { PreviewRecord } from '@hongyan/ui/preview';
export const notices: PreviewRecord[] = [
  { id: 'meeting-02', title: '集合通知', status: '当前有效', fields: [['信息版本', '2'], ['集合说明', '请于 09:15 到一层服务台集合。'], ['发送日期', '2026-11-17']] },
];
export const receipts = [
  { name: '林同学', status: '已确认' }, { name: '周同学', status: '已读未确认' }, { name: '许同学', status: '未读' },
];
export const attendance: PreviewRecord[] = [
  { id: 'nov14-lin', title: '林同学 · 到场', status: '已记录', fields: [['服务日期', '2026-11-14'], ['人员情况', '到场'], ['记录说明', '按当日签到核对']] },
  { id: 'nov15-xu', title: '许同学 · 已请假', status: '已记录', fields: [['服务日期', '2026-11-15'], ['人员情况', '已请假'], ['记录说明', '本人提前联系本活动负责人']] },
];

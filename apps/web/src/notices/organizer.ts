import type { PreviewRecord } from '@hongyan/ui/preview';
// 通知与回执已接入真实接口（见 ./ActivityNotices.vue），这里只保留尚未接入的到场记录示例。
export const attendance: PreviewRecord[] = [
  {
    id: 'nov14-lin',
    title: '林同学 · 到场',
    status: '已记录',
    fields: [
      ['服务日期', '2026-11-14'],
      ['人员情况', '到场'],
      ['记录说明', '按当日签到核对'],
    ],
  },
  {
    id: 'nov15-xu',
    title: '许同学 · 已请假',
    status: '已记录',
    fields: [
      ['服务日期', '2026-11-15'],
      ['人员情况', '已请假'],
      ['记录说明', '本人提前联系本活动负责人'],
    ],
  },
];

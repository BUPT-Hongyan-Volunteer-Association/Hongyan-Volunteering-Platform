import type { PreviewRecord } from '@hongyan/ui/preview';
export const appeals: PreviewRecord[] = [
  {
    id: 'missing-01',
    title: '周同学 · 漏记反馈',
    status: '核实中',
    fields: [
      ['服务日期', '2026-11-15'],
      ['申报时长', '1.5 小时'],
      ['本人说明', '当日参与资料整理'],
      ['处理进度', '等待核对签到，后台审核生效记录后结案'],
    ],
  },
];
export const corrections: PreviewRecord[] = [
  {
    id: 'group-01',
    title: 'G2026-003 · 更正服务日期',
    status: '待审核',
    fields: [
      ['源记录', 'L-021 · 林同学 · 11 月 14 日 · 2.0 小时'],
      ['拟建目标', '林同学 · 11 月 15 日 · 2.0 小时'],
      ['更正原因', '原服务日期误录'],
      ['批准后', '整组撤销原记录并建立目标记录'],
      ['当前累计', '原记录仍有效'],
    ],
  },
];

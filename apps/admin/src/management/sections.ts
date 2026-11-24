import type { PreviewRecord } from '@hongyan/ui/preview';
interface AdminSection {
  title: string;
  records: PreviewRecord[];
}
export const sections = {
  corrections: { title: '错账修复组', records: [] },
  incidents: { title: '异常复核', records: [] },
  appeals: { title: '申诉与更正', records: [] },
  students: { title: '学生档案', records: [] },
  imports: { title: '建档导入', records: [] },
  accounts: {
    title: '账号与角色',
    records: [
      {
        id: 'student-0123',
        title: '0000000123 · 林同学',
        status: '学生',
        fields: [
          ['关联档案', 'S0123'],
          ['当前角色', '学生'],
          ['账号状态', '启用'],
        ],
      },
      {
        id: 'staff-002',
        title: 'staff.sample · 合成审核员',
        status: '独立后台账号',
        fields: [
          ['角色', '老师审核员'],
          ['账号状态', '启用'],
        ],
      },
    ],
  },
  failures: {
    title: '通知失败队列',
    records: [
      {
        id: 'EV2026-009',
        title: '集合通知',
        status: '投递失败',
        fields: [
          ['事件来源', '集合信息版本 2'],
          ['尝试次数', '5 次'],
          ['失败原因', '消息生成任务超时'],
          ['重试范围', '重新处理原事件，保留原业务决定'],
        ],
      },
    ],
  },
  audit: { title: '审计记录', records: [] },
} satisfies Record<string, AdminSection>;
export type SectionKey = keyof typeof sections;
export const previewSectionKeys = ['accounts', 'failures'] as const;
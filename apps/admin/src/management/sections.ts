import type { PreviewRecord } from '@hongyan/ui/preview';
interface AdminSection {
  title: string;
  records: PreviewRecord[];
}
export const sections = {
  corrections: {
    title: '错账修复组',
    records: [
      {
        id: 'G2026-003',
        title: 'G2026-003 · 服务日期更正',
        status: '待审核',
        fields: [
          ['源记录', 'L-021 · 林同学 · 11 月 14 日 · 2.0 小时'],
          ['目标记录', '林同学 · 11 月 15 日 · 2.0 小时'],
          ['申请原因', '服务日期误录'],
          ['批准后', '整组撤旧建新，个人累计差额 0.0 小时'],
        ],
      },
    ],
  },
  incidents: {
    title: '异常复核',
    records: [
      {
        id: 'I2026-014',
        title: 'I2026-014 · 到场情况',
        status: '待核实',
        fields: [
          ['学生', '周同学'],
          ['服务日期', '2026-11-14'],
          ['报告事实', '签到时间比集合时间晚十分钟'],
          ['证据', '合成签到说明，原件仅限审核'],
          ['学生可见副本', '待审核发布'],
          ['处罚', '未启用'],
        ],
      },
    ],
  },
  appeals: {
    title: '申诉与更正',
    records: [
      {
        id: 'A2026-012',
        title: 'A2026-012 · 漏记反馈',
        status: '处理中',
        fields: [
          ['申请人', '周同学'],
          ['服务日期', '2026-11-15'],
          ['本人说明', '资料整理时长未显示'],
          ['关联结果', '待批准入账后核对本人当前记录'],
        ],
      },
    ],
  },
  students: {
    title: '学生档案',
    records: [
      {
        id: 'S0123',
        title: '0000000123 · 林同学',
        status: '账号启用',
        fields: [
          ['学号', '0000000123'],
          ['姓名', '林同学'],
          ['级部', '本科生'],
          ['年级', '2026'],
          ['班级', '0000000201'],
        ],
      },
    ],
  },
  imports: {
    title: '建档导入',
    records: [
      {
        id: 'ST2026-001',
        title: 'ST2026-001 · 秋季名单',
        status: '待确认',
        fields: [
          ['文件', '学生建档导入模板_v1.3.xlsx'],
          ['工作表', '学生建档'],
          ['校验结果', '1 行通过，待确认建档'],
        ],
      },
    ],
  },
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
        title: 'EV2026-009 · 集合通知',
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
  audit: {
    title: '审计记录',
    records: [
      {
        id: 'AU2026-017',
        title: 'AU2026-017 · 授予负责人',
        status: '已记录',
        fields: [
          ['操作人', '合成审核员'],
          ['对象', '0000000123'],
          ['操作时间', '2026-11-17 09:30（北京时间）'],
          ['变更原因', '活动交接'],
          ['前后权限', '学生 → 学生、负责人'],
        ],
      },
    ],
  },
} satisfies Record<string, AdminSection>;
export type SectionKey = keyof typeof sections;
export const sectionKeys = Object.keys(sections) as SectionKey[];

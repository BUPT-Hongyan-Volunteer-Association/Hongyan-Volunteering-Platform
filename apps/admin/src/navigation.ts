export const navigation = {
  inbox: { to: '/', label: '待办', icon: 'List' },
  schedule: { to: '/schedule', label: '全院日程', icon: 'Calendar' },
  teams: { to: '/manage/teams', label: '活动团队', icon: 'User' },
  reviews: { to: '/reviews', label: '活动审核', icon: 'DocumentChecked' },
  hours: { to: '/hours', label: '时长审核', icon: 'Clock' },
  corrections: { to: '/manage/corrections', label: '错帐修复', icon: 'CopyDocument' },
  incidents: { to: '/manage/incidents', label: '异常复核', icon: 'Warning' },
  appeals: { to: '/manage/appeals', label: '申诉与更正', icon: 'ChatLineSquare' },
  students: { to: '/manage/students', label: '学生档案', icon: 'User' },
  accounts: { to: '/manage/accounts', label: '账号与角色', icon: 'Key' },
  failures: { to: '/manage/failures', label: '通知失败队列', icon: 'Message' },
  audit: { to: '/manage/audit', label: '审计记录', icon: 'Notebook' },
} as const;

export const groups = [
  [navigation.inbox, navigation.schedule],
  [navigation.teams, navigation.reviews, navigation.hours, navigation.corrections, navigation.incidents, navigation.appeals],
  [navigation.students, navigation.accounts],
  [navigation.failures, navigation.audit],
];

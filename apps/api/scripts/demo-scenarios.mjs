export const demoActivities = {
  open: {
    code: 'P2026-0001', title: '校园读书角整理', status: 'published', serviceDay: 7,
    description: '分组为书架分类，整理借阅登记，并补齐书脊标签',
    campus: '沙河校区', location: '活动室 A', meeting_point: '活动室一层大厅',
  },
  pending: {
    code: 'P2026-0002', title: '校园开放日引导', status: 'pending_review', serviceDay: 14,
    description: '在校门和展区引导来访家庭，协助核对参观路线',
    campus: '西土城校区', location: '开放日咨询台', meeting_point: '南门服务点',
  },
  completed: {
    code: 'P2026-0003', title: '校园无障碍路线巡查', status: 'completed', serviceDay: -7,
    description: '沿教学区无障碍路线逐点巡查，记录通行情况并交回巡查清单',
    campus: '沙河校区', location: '教学区', meeting_point: '教学楼东门',
  },
};

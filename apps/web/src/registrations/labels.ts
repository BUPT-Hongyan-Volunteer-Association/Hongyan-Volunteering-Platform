import type { Registration } from '@hongyan/contracts';

export const registrationLabels: Record<Registration['status'], string> = {
  accepted: '已录取',
  submitted: '已提交，待审核',
  waitlisted: '候补中',
  rejected: '未录取',
  withdrawn: '已撤回',
  exited: '已退出',
};

export const requestKinds = { exit: '退出申请', restoration: '恢复申请' } as const;
export type RequestKind = keyof typeof requestKinds;
export const requestStates = {
  pending: '待处理', approved: '已批准', rejected: '已驳回', withdrawn: '已撤回', cancelled: '已取消',
} as const;

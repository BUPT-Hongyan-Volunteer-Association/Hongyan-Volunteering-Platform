import type { Registration } from '@hongyan/contracts';

export const registrationLabels: Record<Registration['status'], string> = {
  accepted: '已录取',
  submitted: '已提交，待审核',
  waitlisted: '候补中',
  rejected: '未录取',
  withdrawn: '已撤回',
  exited: '已退出',
};

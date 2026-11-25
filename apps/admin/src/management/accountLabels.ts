export const roleLabels = { student: '学生', organizer: '负责人', reviewer: '老师审核员', tech_admin: '技术管理员' } as const;
export const roleOptions = Object.entries(roleLabels).map(([value, label]) => ({ value, label }));
export const accountStatusLabels = { active: '启用', inactive: '停用' } as const;

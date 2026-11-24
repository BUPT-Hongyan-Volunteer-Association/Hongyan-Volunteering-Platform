import type { Prisma } from '../generated/prisma/client.js';

/** 学生档案页面与导出共用的搜索、级部、年级和账号状态条件。 */
export function studentWhere(filters: {
  q?: string;
  cohort?: string;
  grade?: string;
  status?: 'active' | 'inactive';
  student_ids?: string[];
}): Prisma.StudentWhereInput {
  const q = filters.q?.trim();
  return {
    ...(filters.student_ids && { id: { in: filters.student_ids } }),
    ...(filters.cohort && { cohort: filters.cohort }),
    ...(filters.grade && { grade: filters.grade }),
    ...(filters.status && { account: { active: filters.status === 'active' } }),
    ...(q && {
      OR: [
        { student_no: { contains: q } },
        { account: { display_name: { contains: q } } },
      ],
    }),
  };
}

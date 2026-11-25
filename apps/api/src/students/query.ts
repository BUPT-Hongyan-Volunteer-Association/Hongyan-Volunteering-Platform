import type { StudentPage } from '@hongyan/contracts/types';
import type { Database } from '../database.js';
import { pagination } from '../activities/read.js';
import { invalid } from '../http.js';
import { studentView } from './student-profile.js';
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

export async function listStudents(db: Database, query: Record<string, string>) {
  const { page, page_size, skip } = pagination(query);
  if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 100))
    invalid('q', '搜索词过长');
  if (query.cohort !== undefined && (typeof query.cohort !== 'string' || query.cohort.length > 100))
    invalid('cohort', '级部筛选值无效');
  const status = query.status;
  if (status !== undefined && status !== 'active' && status !== 'inactive')
    invalid('status', '账号状态筛选值无效');
  if (query.grade !== undefined && !/^\d{4}$/.test(query.grade.trim()))
    invalid('grade', '年级筛选值无效');
  const q = query.q?.trim();
  const cohort = query.cohort?.trim();
  const grade = query.grade?.trim();
  const where = studentWhere({ q, cohort, grade, status });
  return db.$transaction(
    async (tx) => {
      const total = await tx.student.count({ where });
      const [options] = await tx.$queryRaw<Pick<StudentPage, 'grade_options' | 'cohort_options'>[]>`
        SELECT COALESCE(array_agg(DISTINCT grade ORDER BY grade DESC) FILTER (WHERE grade <> ''), '{}') AS grade_options,
               COALESCE(array_agg(DISTINCT cohort ORDER BY cohort) FILTER (WHERE cohort <> ''), '{}') AS cohort_options
        FROM student
      `;
      const items =
        skip < total
          ? await tx.student.findMany({
              where,
              include: { account: { select: { display_name: true, active: true } } },
              orderBy: { student_no: 'asc' },
              skip,
              take: page_size,
            })
          : [];
      return {
        items: items.map(studentView),
        page,
        page_size,
        total,
        ...options,
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}

/** 记录表的展示字段。各模块负责把契约对象转换为可阅读的文本。 */
export interface TableRecord {
  id: string;
  title: string;
  status: string;
  fields: [string, string][];
}

export interface SummaryRecord {
  to?: import('vue-router').RouteLocationRaw;
  id: string;
  title: string;
  status: string;
  context?: string;
  summary: string;
  date: string;
  dateLabel?: string;
  unread?: boolean;
}

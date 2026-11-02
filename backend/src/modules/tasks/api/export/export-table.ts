import type { ExportRowView } from '../../application/views';
import { stateOf } from '../responses/task.responses';

/**
 * The export as a table (roadmap §13): one row per addressee of each task, the
 * same columns for every format. Arabic headings and values; ids where a name
 * is no longer known.
 */
export interface ExportTable {
  readonly headings: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

const AUDIENCE: Readonly<Record<string, string>> = {
  TEACHERS: 'المعلمات',
  SUPERVISORS: 'المشرفات',
  ADMINISTRATION: 'الإدارة',
};
const KIND: Readonly<Record<string, string>> = {
  GENERAL: 'إنجاز المهام',
  ATTENDANCE: 'الحضور',
  TEACHING: 'تقارير المعلمات',
};
const STATE: Readonly<Record<string, string>> = {
  ACTIVE: 'نشطة',
  ARCHIVED: 'مؤرشفة',
  CANCELLED: 'ملغاة',
};
const ASSIGNMENT: Readonly<Record<string, string>> = {
  PENDING: 'لم تُستلم',
  ACKNOWLEDGED: 'مستلمة',
  COMPLETED: 'مكتملة',
};
const REPORT: Readonly<Record<string, string>> = {
  PENDING_REVIEW: 'بانتظار المراجعة',
  APPROVED: 'معتمد',
  CHANGES_REQUESTED: 'يحتاج إلى تعديل',
};

const instant = (date: Date | null): string => (date === null ? '' : date.toISOString());

export function exportTable(
  rows: readonly ExportRowView[],
  names: ReadonlyMap<string, string>,
): ExportTable {
  return {
    headings: [
      'المهمة',
      'النوع',
      'تاريخ النشر',
      'الحالة',
      'المستلمة',
      'الفئة',
      'حالة الاستجابة',
      'وقت الاستلام',
      'وقت الإكمال',
      'حالة التقرير',
      'وقت الاعتماد',
    ],
    rows: rows.map(({ task, assignment, report }) => [
      task.title,
      KIND[task.kind] ?? task.kind,
      instant(task.createdAt),
      STATE[stateOf(task)] ?? '',
      names.get(assignment.recipientId) ?? assignment.recipientId,
      AUDIENCE[assignment.audience] ?? assignment.audience,
      ASSIGNMENT[assignment.status] ?? assignment.status,
      instant(assignment.acknowledgedAt),
      instant(assignment.completedAt),
      report === null ? '' : (REPORT[report.status] ?? report.status),
      instant(report?.approvedAt ?? null),
    ]),
  };
}

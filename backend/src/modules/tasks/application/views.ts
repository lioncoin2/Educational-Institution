/**
 * The application-owned names the API layer maps to the wire (the layering rule:
 * `api/` never imports `domain/`). The domain values ARE the views — re-exported
 * here, not copied, so a field added in the domain cannot drift from its view.
 */
export type { Assignment as AssignmentView } from '../domain/assignment';
export type {
  Report as ReportView,
  ReportReview as ReviewView,
  ReportVersion as VersionView,
} from '../domain/report';
export type { Task as TaskView, TaskRevision as RevisionView } from '../domain/task';
export type { TaskEventEntry as LogEntryView } from '../domain/task-event';
export type { TaskTemplate as TemplateView } from '../domain/template';
export type {
  MyTaskItem as MyTaskItemView,
  ReportSummary as ReportSummaryView,
  ResponseTotals as ResponseTotalsView,
  TaskCounts as TaskCountsView,
  TaskFilter as TaskFilterView,
  TaskStatisticsResult as StatisticsView,
  ExportRow as ExportRowView,
} from '../domain/read-ports';
export type { AssignmentFilter as AssignmentFilterView } from '../domain/ports';

/** The vocabularies a request may name — validated at the edge, decided in the domain. */
export { TASK_AUDIENCES } from '../domain/audience';
export { APPROVAL_MODES, REPORT_CATEGORIES, TASK_BUTTONS, TASK_KINDS } from '../domain/task-config';
export { REPORT_STATUSES } from '../domain/report';
export { REPORT_BODY_MAX, REVIEW_NOTE_MAX } from '../domain/report';
export { TASK_BODY_MAX, TASK_TITLE_MAX } from '../domain/task-config';

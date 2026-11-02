import type { Assignment, AssignmentStatus } from '../domain/assignment';
import type { TaskAudience } from '../domain/audience';
import type {
  Report,
  ReportReview,
  ReportStatus,
  ReportVersion,
  ReviewDecision,
} from '../domain/report';
import type { Task, TaskRevision, TaskStatus } from '../domain/task';
import type { ApprovalMode, ReportCategory, TaskButton, TaskKind } from '../domain/task-config';
import type { TaskEventAction, TaskEventEntry } from '../domain/task-event';
import type { TaskTemplate } from '../domain/template';
import type {
  tasks,
  tasksAssignments,
  tasksEvents,
  tasksReportReviews,
  tasksReports,
  tasksReportVersions,
  tasksRevisions,
  tasksTemplates,
} from './schema';

/**
 * Rows ↔ domain values for the tasks tables. The CHECK constraints guarantee the
 * vocabularies, so the narrowing casts below only restate what the database
 * already enforces.
 */

type TaskRow = typeof tasks.$inferSelect;
type AssignmentRow = typeof tasksAssignments.$inferSelect;
type ReportRow = typeof tasksReports.$inferSelect;

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    kind: row.kind as TaskKind,
    buttons: row.buttons as TaskButton[],
    reportRequired: row.reportRequired,
    approvalMode: row.approvalMode as ApprovalMode,
    audiences: row.audiences as TaskAudience[],
    communityId: row.communityId,
    revision: row.revision,
    status: row.status as TaskStatus,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
    archivedAt: row.archivedAt,
    templateId: row.templateId,
    republishedFrom: row.republishedFrom,
  };
}

export function taskValues(task: Task, clientRequestId: string | null): typeof tasks.$inferInsert {
  return {
    id: task.id,
    title: task.title,
    body: task.body,
    kind: task.kind,
    buttons: [...task.buttons],
    reportRequired: task.reportRequired,
    approvalMode: task.approvalMode,
    audiences: [...task.audiences],
    communityId: task.communityId,
    revision: task.revision,
    status: task.status,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    cancelledAt: task.cancelledAt,
    cancelledBy: task.cancelledBy,
    archivedAt: task.archivedAt,
    templateId: task.templateId,
    republishedFrom: task.republishedFrom,
    clientRequestId,
  };
}

export function toRevision(row: typeof tasksRevisions.$inferSelect): TaskRevision {
  return {
    taskId: row.taskId,
    revision: row.revision,
    title: row.title,
    body: row.body,
    kind: row.kind as TaskKind,
    buttons: row.buttons as TaskButton[],
    reportRequired: row.reportRequired,
    approvalMode: row.approvalMode as ApprovalMode,
    editedBy: row.editedBy,
    editedAt: row.editedAt,
    requireReacknowledge: row.requireReacknowledge,
  };
}

export function revisionValues(revision: TaskRevision): typeof tasksRevisions.$inferInsert {
  return { ...revision, buttons: [...revision.buttons] };
}

export function toAssignment(row: AssignmentRow): Assignment {
  return {
    ...row,
    audience: row.audience as TaskAudience,
    status: row.status as AssignmentStatus,
  };
}

export function assignmentValues(assignment: Assignment): typeof tasksAssignments.$inferInsert {
  return { ...assignment };
}

export function toReport(row: ReportRow): Report {
  return {
    ...row,
    category: row.category as ReportCategory,
    status: row.status as ReportStatus,
  };
}

export function reportValues(report: Report): typeof tasksReports.$inferInsert {
  return { ...report };
}

export function toVersion(row: typeof tasksReportVersions.$inferSelect): ReportVersion {
  return { ...row };
}

export function toReview(row: typeof tasksReportReviews.$inferSelect): ReportReview {
  return { ...row, decision: row.decision as ReviewDecision };
}

export function toTemplate(row: typeof tasksTemplates.$inferSelect): TaskTemplate {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    kind: row.kind as TaskKind,
    buttons: row.buttons as TaskButton[],
    reportRequired: row.reportRequired,
    approvalMode: row.approvalMode as ApprovalMode,
    audiences: row.audiences as TaskAudience[],
    communityId: row.communityId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export function toEventEntry(row: typeof tasksEvents.$inferSelect): TaskEventEntry {
  return {
    sequence: row.sequence,
    taskId: row.taskId,
    action: row.action as TaskEventAction,
    actorId: row.actorId,
    assignmentId: row.assignmentId,
    reportId: row.reportId,
    detail: row.detail,
    occurredAt: row.occurredAt,
  };
}

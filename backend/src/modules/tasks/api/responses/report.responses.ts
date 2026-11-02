import type {
  ReportSummaryView,
  ReportView,
  ReviewView,
  TaskView,
  VersionView,
} from '../../application/views';
import { toTaskResponse, type TaskResponse } from './task.responses';
import { iso, isoOrNull, person, personOrNull, type PersonRef } from './wire';

export interface ReportResponse {
  readonly id: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly author: PersonRef;
  readonly category: string;
  readonly status: string;
  readonly version: number;
  readonly submittedAt: string;
  readonly updatedAt: string;
  /** Who approved the current version (null approver = approved automatically). */
  readonly approvedAt: string | null;
  readonly approvedBy: PersonRef | null;
  readonly deletedAt: string | null;
  readonly deletedBy: PersonRef | null;
}

export interface ReportSummaryResponse extends ReportResponse {
  readonly taskTitle: string;
  readonly taskKind: string;
  readonly audience: string;
}

export interface VersionResponse {
  readonly version: number;
  readonly body: string;
  readonly editedBy: PersonRef;
  readonly editedAt: string;
}

export interface ReviewResponse {
  readonly version: number;
  readonly decision: string;
  readonly note: string | null;
  readonly reviewer: PersonRef;
  readonly decidedAt: string;
}

export interface ReportDetailResponse {
  readonly report: ReportResponse;
  readonly task: TaskResponse;
  readonly versions: readonly VersionResponse[];
  readonly reviews: readonly ReviewResponse[];
}

const NO_NAMES: ReadonlyMap<string, string> = new Map();

export function toReportResponse(
  report: ReportView,
  names: ReadonlyMap<string, string> = NO_NAMES,
): ReportResponse {
  return {
    id: report.id,
    taskId: report.taskId,
    assignmentId: report.assignmentId,
    author: person(report.authorId, names),
    category: report.category,
    status: report.status,
    version: report.version,
    submittedAt: iso(report.submittedAt),
    updatedAt: iso(report.updatedAt),
    approvedAt: isoOrNull(report.approvedAt),
    approvedBy: personOrNull(report.approvedBy, names),
    deletedAt: isoOrNull(report.deletedAt),
    deletedBy: personOrNull(report.deletedBy, names),
  };
}

export function toSummaryResponse(
  summary: ReportSummaryView,
  names: ReadonlyMap<string, string>,
): ReportSummaryResponse {
  return {
    ...toReportResponse(summary.report, names),
    taskTitle: summary.taskTitle,
    taskKind: summary.taskKind,
    audience: summary.audience,
  };
}

export function toVersionResponse(
  version: VersionView,
  names: ReadonlyMap<string, string> = NO_NAMES,
): VersionResponse {
  return {
    version: version.version,
    body: version.body,
    editedBy: person(version.editedBy, names),
    editedAt: iso(version.editedAt),
  };
}

export function toReviewResponse(
  review: ReviewView,
  names: ReadonlyMap<string, string> = NO_NAMES,
): ReviewResponse {
  return {
    version: review.version,
    decision: review.decision,
    note: review.note,
    reviewer: person(review.reviewerId, names),
    decidedAt: iso(review.decidedAt),
  };
}

export function toReportDetailResponse(view: {
  report: ReportView;
  task: TaskView;
  versions: readonly VersionView[];
  reviews: readonly ReviewView[];
  names: ReadonlyMap<string, string>;
}): ReportDetailResponse {
  return {
    report: toReportResponse(view.report, view.names),
    task: toTaskResponse(view.task),
    versions: view.versions.map((v) => toVersionResponse(v, view.names)),
    reviews: view.reviews.map((r) => toReviewResponse(r, view.names)),
  };
}

import type {
  AssignmentView,
  MyTaskItemView,
  ReportView,
  ReviewView,
  TaskView,
  VersionView,
} from '../../application/views';
import {
  toReportResponse,
  toReviewResponse,
  toVersionResponse,
  type ReportResponse,
  type ReviewResponse,
  type VersionResponse,
} from './report.responses';
import { toTaskResponse, type TaskResponse } from './task.responses';
import { iso, isoOrNull, person, personOrNull, type PersonRef } from './wire';

export interface AssignmentResponse {
  readonly id: string;
  readonly taskId: string;
  readonly status: string;
  readonly audience: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedRevision: number | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly reassignedAt: string | null;
  readonly replaces: string | null;
  readonly reassignedTo: string | null;
}

/** One addressee on the follow-up page (roadmap §4). */
export interface TrackingRowResponse extends AssignmentResponse {
  readonly recipient: PersonRef;
  readonly reassignedBy: PersonRef | null;
  readonly report: {
    readonly id: string;
    readonly status: string;
    readonly version: number;
  } | null;
}

/** One of the recipient's own tasks. */
export interface MyTaskResponse {
  readonly assignment: AssignmentResponse;
  readonly task: TaskResponse;
  readonly report: ReportResponse | null;
}

export interface MyTaskDetailResponse extends MyTaskResponse {
  readonly latest: VersionResponse | null;
  readonly reviews: readonly ReviewResponse[];
}

export function toAssignmentResponse(assignment: AssignmentView): AssignmentResponse {
  return {
    id: assignment.id,
    taskId: assignment.taskId,
    status: assignment.status,
    audience: assignment.audience,
    acknowledgedAt: isoOrNull(assignment.acknowledgedAt),
    acknowledgedRevision: assignment.acknowledgedRevision,
    completedAt: isoOrNull(assignment.completedAt),
    createdAt: iso(assignment.createdAt),
    reassignedAt: isoOrNull(assignment.reassignedAt),
    replaces: assignment.replaces,
    reassignedTo: assignment.reassignedTo,
  };
}

export function toTrackingRow(
  row: { assignment: AssignmentView; report: ReportView | null },
  names: ReadonlyMap<string, string>,
): TrackingRowResponse {
  return {
    ...toAssignmentResponse(row.assignment),
    recipient: person(row.assignment.recipientId, names),
    reassignedBy: personOrNull(row.assignment.reassignedBy, names),
    report:
      row.report === null
        ? null
        : { id: row.report.id, status: row.report.status, version: row.report.version },
  };
}

export function toMyTaskResponse(item: MyTaskItemView): MyTaskResponse {
  return {
    assignment: toAssignmentResponse(item.assignment),
    task: toTaskResponse(item.task),
    report: item.report === null ? null : toReportResponse(item.report),
  };
}

export function toMyTaskDetailResponse(view: {
  assignment: AssignmentView;
  task: TaskView;
  report: ReportView | null;
  latest: VersionView | null;
  reviews: readonly ReviewView[];
}): MyTaskDetailResponse {
  return {
    ...toMyTaskResponse(view),
    latest: view.latest === null ? null : toVersionResponse(view.latest),
    reviews: view.reviews.map((review) => toReviewResponse(review)),
  };
}

import type { RevisionView, TaskCountsView, TaskView } from '../../application/views';
import { iso, isoOrNull, person, personOrNull, type PersonRef } from './wire';

export interface TaskResponse {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly kind: string;
  readonly buttons: readonly string[];
  readonly reportRequired: boolean;
  readonly approvalMode: string;
  readonly audiences: readonly string[];
  readonly communityId: string | null;
  readonly revision: number;
  /** ACTIVE, ARCHIVED or CANCELLED — what the screens show. */
  readonly state: 'ACTIVE' | 'ARCHIVED' | 'CANCELLED';
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelledAt: string | null;
  readonly cancelledBy: string | null;
  readonly archivedAt: string | null;
  readonly templateId: string | null;
  readonly republishedFrom: string | null;
}

export type CountsResponse = TaskCountsView;

export interface TaskOverviewResponse {
  readonly task: TaskResponse;
  readonly counts: CountsResponse;
}

export interface RevisionResponse {
  readonly revision: number;
  readonly title: string;
  readonly body: string;
  readonly kind: string;
  readonly buttons: readonly string[];
  readonly reportRequired: boolean;
  readonly approvalMode: string;
  readonly editedBy: PersonRef;
  readonly editedAt: string;
  readonly requireReacknowledge: boolean;
}

export interface TaskDetailResponse extends TaskOverviewResponse {
  readonly createdBy: PersonRef;
  readonly cancelledBy: PersonRef | null;
  readonly revisions: readonly RevisionResponse[];
}

export function stateOf(task: TaskView): TaskResponse['state'] {
  if (task.status === 'CANCELLED') return 'CANCELLED';
  return task.archivedAt === null ? 'ACTIVE' : 'ARCHIVED';
}

export function toTaskResponse(task: TaskView): TaskResponse {
  return {
    id: task.id,
    title: task.title,
    body: task.body,
    kind: task.kind,
    buttons: task.buttons,
    reportRequired: task.reportRequired,
    approvalMode: task.approvalMode,
    audiences: task.audiences,
    communityId: task.communityId,
    revision: task.revision,
    state: stateOf(task),
    createdBy: task.createdBy,
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
    cancelledAt: isoOrNull(task.cancelledAt),
    cancelledBy: task.cancelledBy,
    archivedAt: isoOrNull(task.archivedAt),
    templateId: task.templateId,
    republishedFrom: task.republishedFrom,
  };
}

export function toOverviewResponse(view: {
  task: TaskView;
  counts: TaskCountsView;
}): TaskOverviewResponse {
  return { task: toTaskResponse(view.task), counts: view.counts };
}

export function toDetailResponse(view: {
  task: TaskView;
  counts: TaskCountsView;
  revisions: readonly RevisionView[];
  names: ReadonlyMap<string, string>;
}): TaskDetailResponse {
  return {
    ...toOverviewResponse(view),
    createdBy: person(view.task.createdBy, view.names),
    cancelledBy: personOrNull(view.task.cancelledBy, view.names),
    revisions: view.revisions.map((r) => ({
      revision: r.revision,
      title: r.title,
      body: r.body,
      kind: r.kind,
      buttons: r.buttons,
      reportRequired: r.reportRequired,
      approvalMode: r.approvalMode,
      editedBy: person(r.editedBy, view.names),
      editedAt: iso(r.editedAt),
      requireReacknowledge: r.requireReacknowledge,
    })),
  };
}

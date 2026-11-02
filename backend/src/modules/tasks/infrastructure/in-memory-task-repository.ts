import { Injectable } from '@nestjs/common';

import type { PublishOutcome, TaskRepository } from '../domain/ports';
import { isTaskSettled } from '../domain/settlement';
import { initialRevision, type Task, type TaskRevision } from '../domain/task';
import type { TaskEventRecord } from '../domain/task-event';
import { InMemoryTasksState } from './in-memory-tasks-state';

/** The task lifecycle's acts in memory — same guarantees as `DrizzleTaskRepository`. */
@Injectable()
export class InMemoryTaskRepository implements TaskRepository {
  constructor(private readonly state: InMemoryTasksState) {}

  async publish(input: Parameters<TaskRepository['publish']>[0]): Promise<PublishOutcome> {
    const key =
      input.clientRequestId === null
        ? null
        : `${input.task.createdBy}\u0000${input.clientRequestId}`;
    const existingId = key === null ? undefined : this.state.clientKeys.get(key);
    if (existingId !== undefined) {
      return { status: 'duplicate', task: this.state.tasks.get(existingId) as Task };
    }
    this.state.tasks.set(input.task.id, input.task);
    if (key !== null) this.state.clientKeys.set(key, input.task.id);
    this.state.revisions.set(input.task.id, [initialRevision(input.task)]);
    for (const assignment of input.assignments)
      this.state.assignments.set(assignment.id, assignment);
    this.state.appendEvents([input.event]);
    return { status: 'created', task: input.task };
  }

  async findById(id: string): Promise<Task | null> {
    return this.state.tasks.get(id) ?? null;
  }

  async edit(
    next: Task,
    revision: TaskRevision,
    event: TaskEventRecord,
  ): Promise<'saved' | 'stale'> {
    const stored = this.state.tasks.get(next.id);
    if (stored === undefined || stored.revision !== next.revision - 1) return 'stale';
    this.state.tasks.set(next.id, next);
    this.state.revisions.get(next.id)?.push(revision);
    if (revision.requireReacknowledge) {
      for (const assignment of this.state.assignmentsOf(next.id)) {
        if (assignment.status !== 'ACKNOWLEDGED') continue;
        this.state.assignments.set(assignment.id, {
          ...assignment,
          status: 'PENDING',
          acknowledgedAt: null,
          acknowledgedRevision: null,
        });
      }
    }
    this.state.appendEvents([event]);
    return 'saved';
  }

  async revisions(taskId: string): Promise<readonly TaskRevision[]> {
    return [...(this.state.revisions.get(taskId) ?? [])];
  }

  async changeLifecycle(next: Task, expected: Task, event: TaskEventRecord): Promise<boolean> {
    const stored = this.state.tasks.get(next.id);
    if (
      stored === undefined ||
      stored.status !== expected.status ||
      (stored.archivedAt === null) !== (expected.archivedAt === null)
    ) {
      return false;
    }
    this.state.tasks.set(next.id, { ...stored, ...lifecycleOf(next) });
    this.state.appendEvents([event]);
    return true;
  }

  async archiveIfSettled(taskId: string, at: Date): Promise<boolean> {
    const task = this.state.tasks.get(taskId);
    if (task === undefined) return false;
    const settled = isTaskSettled(
      task,
      this.state.assignmentsOf(taskId),
      this.state.reportsByAssignment(taskId),
    );
    if (!settled) return false;
    this.state.tasks.set(taskId, { ...task, archivedAt: at, updatedAt: at });
    this.state.appendEvents([
      {
        taskId,
        action: 'TASK_ARCHIVED',
        actorId: null,
        assignmentId: null,
        reportId: null,
        detail: {},
        occurredAt: at,
      },
    ]);
    return true;
  }
}

/** The fields a lifecycle change writes — the same set as the Postgres UPDATE. */
function lifecycleOf(task: Task): Partial<Task> {
  return {
    status: task.status,
    cancelledAt: task.cancelledAt,
    cancelledBy: task.cancelledBy,
    archivedAt: task.archivedAt,
    updatedAt: task.updatedAt,
  };
}

import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { PublishOutcome, TaskRepository } from '../domain/ports';
import { initialRevision, type Task, type TaskRevision } from '../domain/task';
import type { TaskEventRecord } from '../domain/task-event';
import { insertEvents } from './event-rows';
import { assignmentValues, revisionValues, taskValues, toRevision, toTask } from './row-mapping';
import { tasks, tasksAssignments, tasksRevisions } from './schema';

/** Rows per INSERT when snapshotting a large audience. */
const ASSIGNMENT_BATCH = 500;

/** The task lifecycle's acts on Postgres (ADR 0052 §1): each one transaction. */
@Injectable()
export class DrizzleTaskRepository implements TaskRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async publish(input: Parameters<TaskRepository['publish']>[0]): Promise<PublishOutcome> {
    return this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(tasks)
        .values(taskValues(input.task, input.clientRequestId))
        .onConflictDoNothing()
        .returning();
      if (inserted === undefined) {
        // The creator's key was already used: answer with what it created.
        const existing = await this.findByClientKey(input.task.createdBy, input.clientRequestId);
        if (existing === null) throw new Error('a task insert conflict without its row');
        return { status: 'duplicate', task: existing };
      }
      await tx.insert(tasksRevisions).values(revisionValues(initialRevision(input.task)));
      for (let start = 0; start < input.assignments.length; start += ASSIGNMENT_BATCH) {
        const batch = input.assignments.slice(start, start + ASSIGNMENT_BATCH);
        await tx.insert(tasksAssignments).values(batch.map(assignmentValues));
      }
      await insertEvents(tx, [input.event]);
      return { status: 'created', task: toTask(inserted) };
    });
  }

  async findById(id: string): Promise<Task | null> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return row === undefined ? null : toTask(row);
  }

  async edit(
    next: Task,
    revision: TaskRevision,
    event: TaskEventRecord,
  ): Promise<'saved' | 'stale'> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(tasks)
        .set({
          title: next.title,
          body: next.body,
          kind: next.kind,
          buttons: [...next.buttons],
          reportRequired: next.reportRequired,
          approvalMode: next.approvalMode,
          revision: next.revision,
          updatedAt: next.updatedAt,
        })
        .where(and(eq(tasks.id, next.id), eq(tasks.revision, next.revision - 1)))
        .returning({ id: tasks.id });
      if (updated.length === 0) return 'stale';
      await tx.insert(tasksRevisions).values(revisionValues(revision));
      if (revision.requireReacknowledge) {
        await tx
          .update(tasksAssignments)
          .set({ status: 'PENDING', acknowledgedAt: null, acknowledgedRevision: null })
          .where(
            and(eq(tasksAssignments.taskId, next.id), eq(tasksAssignments.status, 'ACKNOWLEDGED')),
          );
      }
      await insertEvents(tx, [event]);
      return 'saved';
    });
  }

  async revisions(taskId: string): Promise<readonly TaskRevision[]> {
    const rows = await this.db
      .select()
      .from(tasksRevisions)
      .where(eq(tasksRevisions.taskId, taskId))
      .orderBy(asc(tasksRevisions.revision));
    return rows.map(toRevision);
  }

  async changeLifecycle(next: Task, expected: Task, event: TaskEventRecord): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(tasks)
        .set({
          status: next.status,
          cancelledAt: next.cancelledAt,
          cancelledBy: next.cancelledBy,
          archivedAt: next.archivedAt,
          updatedAt: next.updatedAt,
        })
        .where(
          and(
            eq(tasks.id, next.id),
            eq(tasks.status, expected.status),
            expected.archivedAt === null ? isNull(tasks.archivedAt) : isNotNull(tasks.archivedAt),
          ),
        )
        .returning({ id: tasks.id });
      if (updated.length === 0) return false;
      await insertEvents(tx, [event]);
      return true;
    });
  }

  /**
   * `isTaskSettled` (domain/settlement.ts) as one guarded UPDATE: an open,
   * unarchived task with at least one holder, every holder COMPLETED, and — when
   * a report is required — every holder's report APPROVED.
   */
  async archiveIfSettled(taskId: string, at: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const archived = await tx
        .update(tasks)
        .set({ archivedAt: at, updatedAt: at })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.status, 'OPEN'),
            isNull(tasks.archivedAt),
            sql`exists (select 1 from tasks_assignments a
                        where a.task_id = ${tasks.id} and a.status <> 'REASSIGNED')`,
            sql`not exists (select 1 from tasks_assignments a
                            where a.task_id = ${tasks.id} and a.status in ('PENDING', 'ACKNOWLEDGED'))`,
            sql`(not ${tasks.reportRequired} or not exists (
                  select 1 from tasks_assignments a
                  left join tasks_reports r on r.assignment_id = a.id
                  where a.task_id = ${tasks.id} and a.status = 'COMPLETED'
                    and (r.id is null or r.status <> 'APPROVED')))`,
          ),
        )
        .returning({ id: tasks.id });
      if (archived.length === 0) return false;
      await insertEvents(tx, [
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
    });
  }

  private async findByClientKey(createdBy: string, key: string | null): Promise<Task | null> {
    if (key === null) return null;
    const [row] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.createdBy, createdBy), eq(tasks.clientRequestId, key)));
    return row === undefined ? null : toTask(row);
  }
}

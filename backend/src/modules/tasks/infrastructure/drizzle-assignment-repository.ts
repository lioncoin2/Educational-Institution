import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or, type SQL } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { Assignment } from '../domain/assignment';
import type { AssignmentFilter, AssignmentRepository } from '../domain/ports';
import type { Report, ReportVersion } from '../domain/report';
import type { TaskEventRecord } from '../domain/task-event';
import { insertEvents } from './event-rows';
import { assignmentValues, reportValues, toAssignment } from './row-mapping';
import { tasksAssignments, tasksReports, tasksReportVersions } from './schema';

/** Raised inside a transaction to undo it when an act lost a race. */
class LostRace extends Error {}

const OPEN = ne(tasksAssignments.status, 'REASSIGNED');

const FILTERS: Readonly<Record<AssignmentFilter, SQL | undefined>> = {
  ALL: undefined,
  RESPONDED: and(
    OPEN,
    or(isNotNull(tasksAssignments.acknowledgedAt), isNotNull(tasksAssignments.completedAt)),
  ),
  NOT_RESPONDED: and(
    OPEN,
    isNull(tasksAssignments.acknowledgedAt),
    isNull(tasksAssignments.completedAt),
  ),
  COMPLETED: eq(tasksAssignments.status, 'COMPLETED'),
  NOT_COMPLETED: inArray(tasksAssignments.status, ['PENDING', 'ACKNOWLEDGED']),
};

/** One addressee's acts on Postgres (ADR 0052 §1, §5): each one transaction. */
@Injectable()
export class DrizzleAssignmentRepository implements AssignmentRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string): Promise<Assignment | null> {
    const [row] = await this.db.select().from(tasksAssignments).where(eq(tasksAssignments.id, id));
    return row === undefined ? null : toAssignment(row);
  }

  async listByTask(
    taskId: string,
    filter: AssignmentFilter,
    afterId: string | null,
    limit: number,
  ): Promise<readonly Assignment[]> {
    const rows = await this.db
      .select()
      .from(tasksAssignments)
      .where(
        and(
          eq(tasksAssignments.taskId, taskId),
          FILTERS[filter],
          afterId === null ? undefined : gt(tasksAssignments.id, afterId),
        ),
      )
      .orderBy(asc(tasksAssignments.id))
      .limit(limit);
    return rows.map(toAssignment);
  }

  async findOpenFor(taskId: string, recipientId: string): Promise<Assignment | null> {
    const [row] = await this.db
      .select()
      .from(tasksAssignments)
      .where(
        and(
          eq(tasksAssignments.taskId, taskId),
          eq(tasksAssignments.recipientId, recipientId),
          OPEN,
        ),
      );
    return row === undefined ? null : toAssignment(row);
  }

  async nonResponders(taskId: string): Promise<readonly Assignment[]> {
    return this.all(taskId, FILTERS.NOT_RESPONDED);
  }

  async openNotCompleted(taskId: string): Promise<readonly Assignment[]> {
    return this.all(taskId, FILTERS.NOT_COMPLETED);
  }

  async acknowledge(next: Assignment, event: TaskEventRecord): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(tasksAssignments)
        .set({
          status: next.status,
          acknowledgedAt: next.acknowledgedAt,
          acknowledgedRevision: next.acknowledgedRevision,
          completedAt: next.completedAt,
        })
        .where(and(eq(tasksAssignments.id, next.id), eq(tasksAssignments.status, 'PENDING')))
        .returning({ id: tasksAssignments.id });
      if (updated.length === 0) return false;
      await insertEvents(tx, [event]);
      return true;
    });
  }

  async complete(
    next: Assignment,
    report: { readonly report: Report; readonly version: ReportVersion } | null,
    events: readonly TaskEventRecord[],
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(tasksAssignments)
        .set({ status: 'COMPLETED', completedAt: next.completedAt })
        .where(
          and(
            eq(tasksAssignments.id, next.id),
            inArray(tasksAssignments.status, ['PENDING', 'ACKNOWLEDGED']),
          ),
        )
        .returning({ id: tasksAssignments.id });
      if (updated.length === 0) return false;
      if (report !== null) {
        await tx.insert(tasksReports).values(reportValues(report.report));
        await tx.insert(tasksReportVersions).values({ ...report.version });
      }
      await insertEvents(tx, events);
      return true;
    });
  }

  async reassign(closed: Assignment, opened: Assignment, event: TaskEventRecord): Promise<boolean> {
    try {
      return await this.db.transaction(async (tx) => {
        const updated = await tx
          .update(tasksAssignments)
          .set({
            status: 'REASSIGNED',
            reassignedTo: closed.reassignedTo,
            reassignedAt: closed.reassignedAt,
            reassignedBy: closed.reassignedBy,
          })
          .where(and(eq(tasksAssignments.id, closed.id), OPEN))
          .returning({ id: tasksAssignments.id });
        if (updated.length === 0) return false;
        const inserted = await tx
          .insert(tasksAssignments)
          .values(assignmentValues(opened))
          .onConflictDoNothing()
          .returning({ id: tasksAssignments.id });
        // The new addressee already holds the task: undo the close as well.
        if (inserted.length === 0) throw new LostRace();
        await insertEvents(tx, [event]);
        return true;
      });
    } catch (error) {
      if (error instanceof LostRace) return false;
      throw error;
    }
  }

  private async all(taskId: string, filter: SQL | undefined): Promise<readonly Assignment[]> {
    const rows = await this.db
      .select()
      .from(tasksAssignments)
      .where(and(eq(tasksAssignments.taskId, taskId), filter))
      .orderBy(asc(tasksAssignments.id));
    return rows.map(toAssignment);
  }
}

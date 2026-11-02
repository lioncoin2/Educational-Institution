import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { ReportRepository } from '../domain/ports';
import type { Report, ReportReview, ReportVersion } from '../domain/report';
import type { TaskEventRecord } from '../domain/task-event';
import { insertEvents } from './event-rows';
import { toReport, toReview, toVersion } from './row-mapping';
import { tasksReportReviews, tasksReports, tasksReportVersions } from './schema';
import type { Transaction } from './transaction';

/** A report's acts on Postgres (ADR 0052 §5): each one transaction. */
@Injectable()
export class DrizzleReportRepository implements ReportRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string): Promise<Report | null> {
    const [row] = await this.db.select().from(tasksReports).where(eq(tasksReports.id, id));
    return row === undefined ? null : toReport(row);
  }

  async findByAssignment(assignmentId: string): Promise<Report | null> {
    const [row] = await this.db
      .select()
      .from(tasksReports)
      .where(eq(tasksReports.assignmentId, assignmentId));
    return row === undefined ? null : toReport(row);
  }

  async findByAssignments(assignmentIds: readonly string[]): Promise<ReadonlyMap<string, Report>> {
    if (assignmentIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(tasksReports)
      .where(inArray(tasksReports.assignmentId, [...assignmentIds]));
    return new Map(rows.map((row) => [row.assignmentId, toReport(row)]));
  }

  async writeVersion(
    next: Report,
    version: ReportVersion,
    event: TaskEventRecord,
  ): Promise<'saved' | 'stale'> {
    return this.db.transaction(async (tx) => {
      const updated = await this.applyState(tx, next, eq(tasksReports.version, next.version - 1));
      if (!updated) return 'stale';
      await tx.insert(tasksReportVersions).values({ ...version });
      await insertEvents(tx, [event]);
      return 'saved';
    });
  }

  async review(next: Report, review: ReportReview, event: TaskEventRecord): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const pendingAtVersion = and(
        eq(tasksReports.version, next.version),
        eq(tasksReports.status, 'PENDING_REVIEW'),
      );
      if (!(await this.applyState(tx, next, pendingAtVersion))) return false;
      await tx.insert(tasksReportReviews).values({ ...review });
      await insertEvents(tx, [event]);
      return true;
    });
  }

  async softDelete(next: Report, event: TaskEventRecord): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      if (!(await this.applyState(tx, next, ne(tasksReports.status, 'DELETED')))) return false;
      await insertEvents(tx, [event]);
      return true;
    });
  }

  async versions(reportId: string): Promise<readonly ReportVersion[]> {
    const rows = await this.db
      .select()
      .from(tasksReportVersions)
      .where(eq(tasksReportVersions.reportId, reportId))
      .orderBy(asc(tasksReportVersions.version));
    return rows.map(toVersion);
  }

  async reviews(reportId: string): Promise<readonly ReportReview[]> {
    const rows = await this.db
      .select()
      .from(tasksReportReviews)
      .where(eq(tasksReportReviews.reportId, reportId))
      .orderBy(asc(tasksReportReviews.decidedAt), asc(tasksReportReviews.id));
    return rows.map(toReview);
  }

  /** Writes the report's new state if the guard still holds; true when it did. */
  private async applyState(
    tx: Transaction,
    next: Report,
    guard: ReturnType<typeof eq> | undefined,
  ): Promise<boolean> {
    const updated = await tx
      .update(tasksReports)
      .set({
        status: next.status,
        version: next.version,
        updatedAt: next.updatedAt,
        approvedAt: next.approvedAt,
        approvedBy: next.approvedBy,
        deletedAt: next.deletedAt,
        deletedBy: next.deletedBy,
      })
      .where(and(eq(tasksReports.id, next.id), guard))
      .returning({ id: tasksReports.id });
    return updated.length > 0;
  }
}

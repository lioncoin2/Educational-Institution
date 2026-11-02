import { Injectable } from '@nestjs/common';

import type { ReportRepository } from '../domain/ports';
import type { Report, ReportReview, ReportVersion } from '../domain/report';
import type { TaskEventRecord } from '../domain/task-event';
import { InMemoryTasksState } from './in-memory-tasks-state';

/** A report's acts in memory — same guarantees as `DrizzleReportRepository`. */
@Injectable()
export class InMemoryReportRepository implements ReportRepository {
  constructor(private readonly state: InMemoryTasksState) {}

  async findById(id: string): Promise<Report | null> {
    return this.state.reports.get(id) ?? null;
  }

  async findByAssignment(assignmentId: string): Promise<Report | null> {
    return this.state.reportOf(assignmentId) ?? null;
  }

  async findByAssignments(assignmentIds: readonly string[]): Promise<ReadonlyMap<string, Report>> {
    const wanted = new Set(assignmentIds);
    return new Map(
      [...this.state.reports.values()]
        .filter((report) => wanted.has(report.assignmentId))
        .map((report) => [report.assignmentId, report]),
    );
  }

  async writeVersion(
    next: Report,
    version: ReportVersion,
    event: TaskEventRecord,
  ): Promise<'saved' | 'stale'> {
    if (this.state.reports.get(next.id)?.version !== next.version - 1) return 'stale';
    this.state.reports.set(next.id, next);
    this.state.versions.get(next.id)?.push(version);
    this.state.appendEvents([event]);
    return 'saved';
  }

  async review(next: Report, review: ReportReview, event: TaskEventRecord): Promise<boolean> {
    const stored = this.state.reports.get(next.id);
    if (stored?.version !== next.version || stored.status !== 'PENDING_REVIEW') return false;
    this.state.reports.set(next.id, next);
    this.state.reviews.set(next.id, [...(this.state.reviews.get(next.id) ?? []), review]);
    this.state.appendEvents([event]);
    return true;
  }

  async softDelete(next: Report, event: TaskEventRecord): Promise<boolean> {
    const stored = this.state.reports.get(next.id);
    if (stored === undefined || stored.status === 'DELETED') return false;
    this.state.reports.set(next.id, next);
    this.state.appendEvents([event]);
    return true;
  }

  async versions(reportId: string): Promise<readonly ReportVersion[]> {
    return [...(this.state.versions.get(reportId) ?? [])];
  }

  async reviews(reportId: string): Promise<readonly ReportReview[]> {
    return [...(this.state.reviews.get(reportId) ?? [])];
  }
}

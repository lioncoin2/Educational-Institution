import { Inject, Injectable } from '@nestjs/common';

import { clampLimit, err, ok, type Principal, type Result } from '../../../../shared';
import {
  REPORT_REPOSITORY,
  TASK_REPOSITORY,
  type ReportRepository,
  type TaskRepository,
} from '../../domain/ports';
import {
  TASK_READ_MODEL,
  type ReportSummary,
  type TaskFilter,
  type TaskReadModel,
} from '../../domain/read-ports';
import type { ReportCategory } from '../../domain/task-config';
import { decodeInstantCursor, encodeInstantCursor, page } from '../cursors';
import { PersonNames } from '../person-names';
import { REPORT_NOT_FOUND } from '../task-failures';
import { TasksAccess } from '../tasks-access';
import type { ReportDetail } from './report-views';

/** The reports page (roadmap §5): every report, by category and filters, newest first. */
@Injectable()
export class ListReportsUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_READ_MODEL) private readonly reads: TaskReadModel,
    private readonly names: PersonNames,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly filter: TaskFilter & { readonly category?: ReportCategory };
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<
    Result<{
      readonly items: readonly ReportSummary[];
      readonly names: ReadonlyMap<string, string>;
      readonly nextCursor?: string;
    }>
  > {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const after = decodeInstantCursor(command.cursor);
    if (!after.ok) return after;
    const limit = clampLimit(command.limit);
    const rows = await this.reads.listReports(
      command.filter,
      after.value && { updatedAt: after.value.at, id: after.value.id },
      limit + 1,
    );
    const paged = page(rows, limit, (last) =>
      encodeInstantCursor({ at: last.report.updatedAt, id: last.report.id }),
    );
    const names = await this.names.of(
      paged.items.flatMap((s) => [s.report.authorId, s.report.approvedBy]),
    );
    return ok({ ...paged, names });
  }
}

/** One report in full: its versions, its decisions and who made them (roadmap §6). */
@Injectable()
export class GetReportUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(REPORT_REPOSITORY) private readonly reports: ReportRepository,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    private readonly names: PersonNames,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly reportId: string;
  }): Promise<Result<ReportDetail>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const report = await this.reports.findById(command.reportId);
    const task = report === null ? null : await this.tasks.findById(report.taskId);
    if (report === null || task === null) return err(REPORT_NOT_FOUND);
    const [versions, reviews] = await Promise.all([
      this.reports.versions(report.id),
      this.reports.reviews(report.id),
    ]);
    const names = await this.names.of([
      report.authorId,
      report.approvedBy,
      report.deletedBy,
      ...versions.map((v) => v.editedBy),
      ...reviews.map((r) => r.reviewerId),
    ]);
    return ok({ report, task, versions, reviews, names });
  }
}

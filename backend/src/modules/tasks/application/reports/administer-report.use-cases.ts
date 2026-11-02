import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, err, ok, type Clock, type Principal, type Result } from '../../../../shared';
import {
  REPORT_REPOSITORY,
  TASK_REPOSITORY,
  type ReportRepository,
  type TaskRepository,
} from '../../domain/ports';
import { softDeleted, type Report } from '../../domain/report';
import { logEntry } from '../operation-log';
import { CHANGED_MEANWHILE, REPORT_NOT_FOUND } from '../task-failures';
import { TasksAccess } from '../tasks-access';
import { TasksJournal } from '../tasks-journal';
import { ReportWriter } from './report-writer';

/** The administration edits a report as a new version (roadmap §7); the previous one is kept. */
@Injectable()
export class EditReportUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(REPORT_REPOSITORY) private readonly reports: ReportRepository,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    private readonly writer: ReportWriter,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly reportId: string;
    readonly version: number;
    readonly body: string;
  }): Promise<Result<Report>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const report = await this.reports.findById(command.reportId);
    const task = report === null ? null : await this.tasks.findById(report.taskId);
    if (report === null || task === null) return err(REPORT_NOT_FOUND);
    return this.writer.write({
      report,
      task,
      expectedVersion: command.version,
      body: command.body,
      editorId: command.principal.userId,
      by: 'administration',
    });
  }
}

/**
 * The administration deletes a report (roadmap §7): it leaves the lists, but
 * every version, decision and the deletion itself stay on record. The author may
 * submit it again.
 */
@Injectable()
export class DeleteReportUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(REPORT_REPOSITORY) private readonly reports: ReportRepository,
    private readonly journal: TasksJournal,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly reportId: string;
  }): Promise<Result<Report>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const report = await this.reports.findById(command.reportId);
    if (report === null) return err(REPORT_NOT_FOUND);
    if (report.status === 'DELETED') return ok(report);
    const now = this.clock.now();
    const actorId = command.principal.userId;
    const next = softDeleted(report, actorId, now);
    const stored = await this.reports.softDelete(
      next,
      logEntry('REPORT_DELETED', report.taskId, actorId, now, {
        assignmentId: report.assignmentId,
        reportId: report.id,
        detail: { version: report.version },
      }),
    );
    if (!stored) return err(CHANGED_MEANWHILE);
    await this.journal.record({
      actorUserId: actorId,
      action: 'tasks.report.deleted',
      resourceType: 'task_report',
      resourceId: report.id,
      at: now,
      metadata: { version: report.version },
    });
    return ok(next);
  }
}

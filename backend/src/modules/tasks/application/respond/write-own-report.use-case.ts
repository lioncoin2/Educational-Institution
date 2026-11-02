import { Inject, Injectable } from '@nestjs/common';

import { err, type Principal, type Result } from '../../../../shared';
import { REPORT_REPOSITORY, type ReportRepository } from '../../domain/ports';
import type { Report } from '../../domain/report';
import { ReportWriter } from '../reports/report-writer';
import { REPORT_NOT_FOUND } from '../task-failures';
import { OwnTaskLoader } from './own-task';

/**
 * The author edits and resubmits their own report (roadmap §6–§7) — after a
 * request for changes, or to correct it. They can never delete it.
 */
@Injectable()
export class WriteOwnReportUseCase {
  constructor(
    private readonly own: OwnTaskLoader,
    @Inject(REPORT_REPOSITORY) private readonly reports: ReportRepository,
    private readonly writer: ReportWriter,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly assignmentId: string;
    readonly version: number;
    readonly body: string;
  }): Promise<Result<Report>> {
    const loaded = await this.own.load(command.principal, command.assignmentId);
    if (!loaded.ok) return loaded;
    const report = await this.reports.findByAssignment(loaded.value.assignment.id);
    if (report === null) return err(REPORT_NOT_FOUND);
    return this.writer.write({
      report,
      task: loaded.value.task,
      expectedVersion: command.version,
      body: command.body,
      editorId: command.principal.userId,
      by: 'author',
    });
  }
}

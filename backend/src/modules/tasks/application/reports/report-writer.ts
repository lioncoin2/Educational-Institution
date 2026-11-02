import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, domainEvent, err, ok, type Clock, type Result } from '../../../../shared';
import { TasksEvents } from '../../contracts';
import {
  REPORT_REPOSITORY,
  TASK_REPOSITORY,
  type ReportRepository,
  type TaskRepository,
} from '../../domain/ports';
import { normaliseReportBody, withNewVersion, type Report } from '../../domain/report';
import { isActive, type Task } from '../../domain/task';
import { logEntry } from '../operation-log';
import { REVISION_CONFLICT, TASK_NOT_ACTIVE } from '../task-failures';
import { TasksJournal } from '../tasks-journal';

export interface WriteVersionRequest {
  readonly report: Report;
  readonly task: Task;
  /** The version the writer read; a newer stored one is a conflict. */
  readonly expectedVersion: number;
  readonly body: string;
  readonly editorId: string;
  /** The author resubmits; the administration edits on their behalf. */
  readonly by: 'author' | 'administration';
}

/**
 * Writing a new version of an existing report (roadmap §6, §7) — one place for
 * the author's edit/resubmission and the administration's edit. The previous
 * version is kept; the report returns to review (approved at once in AUTO mode).
 */
@Injectable()
export class ReportWriter {
  constructor(
    @Inject(REPORT_REPOSITORY) private readonly reports: ReportRepository,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    private readonly journal: TasksJournal,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async write(request: WriteVersionRequest): Promise<Result<Report>> {
    const { report, task } = request;
    if (!isActive(task)) return err(TASK_NOT_ACTIVE);
    if (report.version !== request.expectedVersion) return err(REVISION_CONFLICT);
    const body = normaliseReportBody(request.body);
    if (!body.ok) return body;

    const now = this.clock.now();
    const next = withNewVersion(report, task.approvalMode, now);
    const byAuthor = request.by === 'author';
    const saved = await this.reports.writeVersion(
      next,
      {
        reportId: report.id,
        version: next.version,
        body: body.value,
        editedBy: request.editorId,
        editedAt: now,
      },
      logEntry(byAuthor ? 'REPORT_SUBMITTED' : 'REPORT_EDITED', task.id, request.editorId, now, {
        assignmentId: report.assignmentId,
        reportId: report.id,
        detail: { version: next.version, status: next.status },
      }),
    );
    if (saved === 'stale') return err(REVISION_CONFLICT);
    await this.journal.record(
      {
        actorUserId: request.editorId,
        action: byAuthor ? 'tasks.report.resubmitted' : 'tasks.report.edited',
        resourceType: 'task_report',
        resourceId: report.id,
        at: now,
        metadata: { version: next.version },
      },
      byAuthor
        ? [
            domainEvent(
              TasksEvents.reportSubmitted,
              task.id,
              {
                taskId: task.id,
                reportId: report.id,
                authorId: report.authorId,
                publisherId: task.createdBy,
                resubmission: true,
              },
              now,
            ),
          ]
        : [],
    );
    await this.tasks.archiveIfSettled(task.id, now);
    return ok(next);
  }
}

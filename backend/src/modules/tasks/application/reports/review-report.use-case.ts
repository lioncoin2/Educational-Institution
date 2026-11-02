import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  domainEvent,
  err,
  ID_GENERATOR,
  ok,
  type Clock,
  type IdGenerator,
  type Principal,
  type Result,
} from '../../../../shared';
import { TasksEvents } from '../../contracts';
import {
  REPORT_REPOSITORY,
  TASK_REPOSITORY,
  type ReportRepository,
  type TaskRepository,
} from '../../domain/ports';
import {
  checkReview,
  decided,
  normaliseReviewNote,
  type Report,
  type ReviewDecision,
} from '../../domain/report';
import { isActive } from '../../domain/task';
import { logEntry } from '../operation-log';
import { CHANGED_MEANWHILE, REPORT_NOT_FOUND, TASK_NOT_ACTIVE } from '../task-failures';
import { TasksAccess } from '../tasks-access';
import { TasksJournal } from '../tasks-journal';

export interface ReviewReportCommand {
  readonly principal: Principal;
  readonly reportId: string;
  /** The version the reviewer read. */
  readonly version: number;
  readonly decision: ReviewDecision;
  /** Required when asking for changes. */
  readonly note?: string | null;
}

/**
 * Approve a report or send it back for changes (roadmap §6). Any member of the
 * administration, and the owner, may decide; who decided and when is shown to
 * all of them so nobody reviews it twice. The author is told.
 */
@Injectable()
export class ReviewReportUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(REPORT_REPOSITORY) private readonly reports: ReportRepository,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    private readonly journal: TasksJournal,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: ReviewReportCommand): Promise<Result<Report>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const report = await this.reports.findById(command.reportId);
    const task = report === null ? null : await this.tasks.findById(report.taskId);
    if (report === null || task === null) return err(REPORT_NOT_FOUND);
    if (!isActive(task)) return err(TASK_NOT_ACTIVE);
    const reviewable = checkReview(report, command.version);
    if (!reviewable.ok) return reviewable;
    const note = normaliseReviewNote(command.note, command.decision === 'CHANGES_REQUESTED');
    if (!note.ok) return note;

    const now = this.clock.now();
    const reviewerId = command.principal.userId;
    const next = decided(report, command.decision, reviewerId, now);
    const approved = command.decision === 'APPROVED';
    const stored = await this.reports.review(
      next,
      {
        id: this.ids.next<'TaskReportReview'>(),
        reportId: report.id,
        version: report.version,
        decision: command.decision,
        note: note.value,
        reviewerId,
        decidedAt: now,
      },
      logEntry(
        approved ? 'REPORT_APPROVED' : 'REPORT_CHANGES_REQUESTED',
        task.id,
        reviewerId,
        now,
        {
          assignmentId: report.assignmentId,
          reportId: report.id,
          detail: { version: report.version },
        },
      ),
    );
    if (!stored) return err(CHANGED_MEANWHILE);
    const fact = { taskId: task.id, reportId: report.id, authorId: report.authorId, reviewerId };
    await this.journal.record(
      {
        actorUserId: reviewerId,
        action: approved ? 'tasks.report.approved' : 'tasks.report.changes_requested',
        resourceType: 'task_report',
        resourceId: report.id,
        at: now,
        metadata: { version: report.version },
      },
      [
        domainEvent(
          approved ? TasksEvents.reportApproved : TasksEvents.reportChangesRequested,
          task.id,
          fact,
          now,
        ),
      ],
    );
    if (approved) await this.tasks.archiveIfSettled(task.id, now);
    return ok(next);
  }
}

import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  domainEvent,
  err,
  ID_GENERATOR,
  ok,
  type Clock,
  type DomainEvent,
  type IdGenerator,
  type Principal,
  type Result,
} from '../../../../shared';
import { TasksEvents } from '../../contracts';
import { checkComplete, type Assignment } from '../../domain/assignment';
import {
  ASSIGNMENT_REPOSITORY,
  TASK_REPOSITORY,
  type AssignmentRepository,
  type TaskRepository,
} from '../../domain/ports';
import {
  firstReport,
  normaliseReportBody,
  type Report,
  type ReportVersion,
} from '../../domain/report';
import { isActive } from '../../domain/task';
import { completionMethod, reportCategoryOf } from '../../domain/task-config';
import type { TaskEventRecord } from '../../domain/task-event';
import { logEntry } from '../operation-log';
import { CHANGED_MEANWHILE, TASK_NOT_ACTIVE } from '../task-failures';
import { TasksJournal } from '../tasks-journal';
import { OwnTaskLoader } from './own-task';

export interface CompleteTaskCommand {
  readonly principal: Principal;
  readonly assignmentId: string;
  /** The written report — required when the task requires one. */
  readonly report?: string | null;
}

/**
 * "تم إكمال المهمة" (roadmap §3, §5): completes the assignment by the task's
 * completion method; a required report comes with it and is stored in the same
 * act. A repeat changes nothing. The task archives itself once settled.
 */
@Injectable()
export class CompleteTaskUseCase {
  constructor(
    private readonly own: OwnTaskLoader,
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepository,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    private readonly journal: TasksJournal,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: CompleteTaskCommand): Promise<Result<Assignment>> {
    const loaded = await this.own.load(command.principal, command.assignmentId);
    if (!loaded.ok) return loaded;
    const { assignment, task } = loaded.value;
    const via = completionMethod(task) === 'REPORT' ? 'report' : 'button';
    const check = checkComplete(assignment, task, via);
    if (!check.ok) return check;
    if (check.value === 'already') return ok(assignment);
    // A repeat is answered as it stands, even once the task has moved on;
    // only a new act needs an active task.
    if (!isActive(task)) return err(TASK_NOT_ACTIVE);

    let body: string | null = null;
    if (task.reportRequired) {
      const text = normaliseReportBody(command.report ?? '');
      if (!text.ok) return text;
      body = text.value;
    }

    const now = this.clock.now();
    const actorId = command.principal.userId;
    const next: Assignment = { ...assignment, status: 'COMPLETED', completedAt: now };
    const written =
      body === null ? null : this.report(assignment, task.kind, task.approvalMode, body, now);
    const log: TaskEventRecord[] = [
      logEntry('ASSIGNMENT_COMPLETED', task.id, actorId, now, { assignmentId: assignment.id }),
    ];
    if (written !== null) {
      log.push(
        logEntry('REPORT_SUBMITTED', task.id, actorId, now, {
          assignmentId: assignment.id,
          reportId: written.report.id,
          detail: { version: 1, status: written.report.status },
        }),
      );
    }
    if (!(await this.assignments.complete(next, written, log))) return err(CHANGED_MEANWHILE);

    const response = {
      taskId: task.id,
      assignmentId: assignment.id,
      recipientId: actorId,
      publisherId: task.createdBy,
    };
    const facts: DomainEvent[] = [domainEvent(TasksEvents.completed, task.id, response, now)];
    if (written !== null) {
      facts.push(
        domainEvent(
          TasksEvents.reportSubmitted,
          task.id,
          {
            taskId: task.id,
            reportId: written.report.id,
            authorId: actorId,
            publisherId: task.createdBy,
            resubmission: false,
          },
          now,
        ),
      );
    }
    await this.journal.record(
      {
        actorUserId: actorId,
        action: 'tasks.assignment.completed',
        resourceType: 'task',
        resourceId: task.id,
        at: now,
        metadata: { assignmentId: assignment.id, reportId: written?.report.id ?? null },
      },
      facts,
    );
    await this.tasks.archiveIfSettled(task.id, now);
    return ok(next);
  }

  private report(
    assignment: Assignment,
    kind: Parameters<typeof reportCategoryOf>[0],
    mode: Parameters<typeof firstReport>[1],
    body: string,
    at: Date,
  ): { readonly report: Report; readonly version: ReportVersion } {
    const report = firstReport(
      {
        id: this.ids.next<'TaskReport'>(),
        taskId: assignment.taskId,
        assignmentId: assignment.id,
        authorId: assignment.recipientId,
        category: reportCategoryOf(kind),
      },
      mode,
      at,
    );
    return {
      report,
      version: {
        reportId: report.id,
        version: 1,
        body,
        editedBy: assignment.recipientId,
        editedAt: at,
      },
    };
  }
}

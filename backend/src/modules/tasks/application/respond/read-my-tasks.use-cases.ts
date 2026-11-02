import { Inject, Injectable } from '@nestjs/common';

import { clampLimit, err, ok, type Principal, type Result } from '../../../../shared';
import type { Assignment } from '../../domain/assignment';
import {
  ASSIGNMENT_REPOSITORY,
  REPORT_REPOSITORY,
  type AssignmentRepository,
  type ReportRepository,
} from '../../domain/ports';
import { TASK_READ_MODEL, type MyTaskItem, type TaskReadModel } from '../../domain/read-ports';
import type { Report, ReportReview, ReportVersion } from '../../domain/report';
import type { Task } from '../../domain/task';
import { decodeInstantCursor, encodeInstantCursor, page } from '../cursors';
import { ASSIGNMENT_NOT_FOUND } from '../task-failures';
import { TasksAccess } from '../tasks-access';
import { OwnTaskLoader } from './own-task';

/** A recipient's list of their tasks: still to do, or done (roadmap §3). */
@Injectable()
export class ListMyTasksUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_READ_MODEL) private readonly reads: TaskReadModel,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly scope: 'OPEN' | 'DONE';
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<{ readonly items: readonly MyTaskItem[]; readonly nextCursor?: string }>> {
    const allowed = this.access.authorizeRespond(command.principal);
    if (!allowed.ok) return allowed;
    const after = decodeInstantCursor(command.cursor);
    if (!after.ok) return after;
    const limit = clampLimit(command.limit);
    const rows = await this.reads.listMine(
      command.principal.userId,
      command.scope,
      after.value && { createdAt: after.value.at, id: after.value.id },
      limit + 1,
    );
    return ok(
      page(rows, limit, (last) =>
        encodeInstantCursor({ at: last.assignment.createdAt, id: last.assignment.id }),
      ),
    );
  }
}

export interface MyTaskDetail {
  readonly assignment: Assignment;
  readonly task: Task;
  readonly report: Report | null;
  /** The report's latest text, when there is one. */
  readonly latest: ReportVersion | null;
  /** Review decisions on the report, oldest first — the notes asking for changes. */
  readonly reviews: readonly ReportReview[];
}

/** One of the recipient's own tasks, with their report and its review notes. */
@Injectable()
export class GetMyTaskUseCase {
  constructor(
    private readonly own: OwnTaskLoader,
    @Inject(REPORT_REPOSITORY) private readonly reports: ReportRepository,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly assignmentId: string;
  }): Promise<Result<MyTaskDetail>> {
    const loaded = await this.own.load(command.principal, command.assignmentId);
    if (!loaded.ok) return loaded;
    const report = await this.reports.findByAssignment(loaded.value.assignment.id);
    if (report === null) return ok({ ...loaded.value, report: null, latest: null, reviews: [] });
    const [versions, reviews] = await Promise.all([
      this.reports.versions(report.id),
      this.reports.reviews(report.id),
    ]);
    return ok({ ...loaded.value, report, latest: versions[versions.length - 1] ?? null, reviews });
  }
}

/**
 * The recipient's own assignment of a task, found from the task — where a
 * notification about the task leads them (`assigned_task` target, ADR 0052 §11).
 */
@Injectable()
export class GetMyTaskByTaskUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepository,
    private readonly detail: GetMyTaskUseCase,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly taskId: string;
  }): Promise<Result<MyTaskDetail>> {
    const allowed = this.access.authorizeRespond(command.principal);
    if (!allowed.ok) return allowed;
    const own = await this.assignments.findOpenFor(command.taskId, command.principal.userId);
    if (own === null) return err(ASSIGNMENT_NOT_FOUND);
    return this.detail.execute({ principal: command.principal, assignmentId: own.id });
  }
}

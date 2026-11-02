import { Inject, Injectable } from '@nestjs/common';

import { clampLimit, err, ok, type Principal, type Result } from '../../../../shared';
import {
  ASSIGNMENT_REPOSITORY,
  REPORT_REPOSITORY,
  TASK_EVENT_LOG,
  TASK_REPOSITORY,
  type AssignmentFilter,
  type AssignmentRepository,
  type ReportRepository,
  type TaskEventLog,
  type TaskRepository,
} from '../../domain/ports';
import { TASK_READ_MODEL, type TaskFilter, type TaskReadModel } from '../../domain/read-ports';
import {
  decodeIdCursor,
  decodeInstantCursor,
  decodeSequenceCursor,
  encodeIdCursor,
  encodeInstantCursor,
  encodeSequenceCursor,
  page,
} from '../cursors';
import { PersonNames } from '../person-names';
import { TASK_NOT_FOUND } from '../task-failures';
import { TasksAccess } from '../tasks-access';
import type { HistoryPage, TaskDetail, TaskOverview, TrackingPage } from './task-views';

/**
 * The administration's reads of tasks (roadmap §4, §15): the searchable list,
 * one task in full, its follow-up page and its operation log. Every one asks
 * `tasks.manage` first, so a guessed id reveals nothing to anyone else.
 */

@Injectable()
export class ListTasksUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_READ_MODEL) private readonly reads: TaskReadModel,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly filter: TaskFilter;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<{ readonly items: readonly TaskOverview[]; readonly nextCursor?: string }>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const after = decodeInstantCursor(command.cursor);
    if (!after.ok) return after;
    const limit = clampLimit(command.limit);
    const rows = await this.reads.listTasks(
      command.filter,
      after.value && { createdAt: after.value.at, id: after.value.id },
      limit + 1,
    );
    return ok(
      page(rows, limit, (last) =>
        encodeInstantCursor({ at: last.task.createdAt, id: last.task.id }),
      ),
    );
  }
}

@Injectable()
export class GetTaskUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    @Inject(TASK_READ_MODEL) private readonly reads: TaskReadModel,
    private readonly names: PersonNames,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly taskId: string;
  }): Promise<Result<TaskDetail>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const task = await this.tasks.findById(command.taskId);
    if (task === null) return err(TASK_NOT_FOUND);
    const [counts, revisions] = await Promise.all([
      this.reads.countsOf(task.id),
      this.tasks.revisions(task.id),
    ]);
    const names = await this.names.of([
      task.createdBy,
      task.cancelledBy,
      ...revisions.map((r) => r.editedBy),
    ]);
    return ok({ task, counts, revisions, names });
  }
}

@Injectable()
export class TrackTaskUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepository,
    @Inject(REPORT_REPOSITORY) private readonly reports: ReportRepository,
    private readonly names: PersonNames,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly taskId: string;
    readonly filter: AssignmentFilter;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<TrackingPage>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    if ((await this.tasks.findById(command.taskId)) === null) return err(TASK_NOT_FOUND);
    const after = decodeIdCursor(command.cursor);
    if (!after.ok) return after;
    const limit = clampLimit(command.limit);
    const rows = await this.assignments.listByTask(
      command.taskId,
      command.filter,
      after.value,
      limit + 1,
    );
    const paged = page(rows, limit, (last) => encodeIdCursor(last.id));
    const reports = await this.reports.findByAssignments(paged.items.map((a) => a.id));
    const names = await this.names.of(paged.items.flatMap((a) => [a.recipientId, a.reassignedBy]));
    return ok({
      items: paged.items.map((assignment) => ({
        assignment,
        report: reports.get(assignment.id) ?? null,
      })),
      names,
      ...(paged.nextCursor === undefined ? {} : { nextCursor: paged.nextCursor }),
    });
  }
}

@Injectable()
export class TaskHistoryUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    @Inject(TASK_EVENT_LOG) private readonly log: TaskEventLog,
    private readonly names: PersonNames,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly taskId: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<HistoryPage>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    if ((await this.tasks.findById(command.taskId)) === null) return err(TASK_NOT_FOUND);
    const after = decodeSequenceCursor(command.cursor);
    if (!after.ok) return after;
    const limit = clampLimit(command.limit);
    const rows = await this.log.list(command.taskId, after.value, limit + 1);
    const paged = page(rows, limit, (last) => encodeSequenceCursor(last.sequence));
    const names = await this.names.of(paged.items.map((entry) => entry.actorId));
    return ok({ ...paged, names });
  }
}

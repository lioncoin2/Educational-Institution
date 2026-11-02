import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  domainEvent,
  err,
  ok,
  type Clock,
  type Principal,
  type Result,
} from '../../../../shared';
import { TasksEvents } from '../../contracts';
import {
  ASSIGNMENT_REPOSITORY,
  TASK_REPOSITORY,
  type AssignmentRepository,
  type TaskRepository,
} from '../../domain/ports';
import { cancel, isActive, type Task } from '../../domain/task';
import { logEntry } from '../operation-log';
import { CHANGED_MEANWHILE, TASK_NOT_ACTIVE, TASK_NOT_FOUND } from '../task-failures';
import { TasksAccess } from '../tasks-access';
import { TasksJournal } from '../tasks-journal';

/**
 * Cancel a published task (roadmap §9): it is archived with its cancellation
 * shown, every response and report kept — never a hard delete. Whoever still had
 * it to do is told.
 */
@Injectable()
export class CancelTaskUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepository,
    private readonly journal: TasksJournal,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly taskId: string;
  }): Promise<Result<Task>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const task = await this.tasks.findById(command.taskId);
    if (task === null) return err(TASK_NOT_FOUND);
    if (!isActive(task)) return err(TASK_NOT_ACTIVE);

    const concerned = await this.assignments.openNotCompleted(task.id);
    const now = this.clock.now();
    const actorId = command.principal.userId;
    const next = cancel(task, actorId, now);
    const changed = await this.tasks.changeLifecycle(
      next,
      task,
      logEntry('TASK_CANCELLED', task.id, actorId, now),
    );
    if (!changed) return err(CHANGED_MEANWHILE);
    await this.journal.record(
      {
        actorUserId: actorId,
        action: 'tasks.task.cancelled',
        resourceType: 'task',
        resourceId: task.id,
        at: now,
      },
      [
        domainEvent(
          TasksEvents.cancelled,
          task.id,
          { taskId: task.id, actorId, recipientUserIds: concerned.map((a) => a.recipientId) },
          now,
        ),
      ],
    );
    return ok(next);
  }
}

import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, err, ok, type Clock, type Principal, type Result } from '../../../../shared';
import { TASK_REPOSITORY, type TaskRepository } from '../../domain/ports';
import { isReopenable, reopen, type Task } from '../../domain/task';
import { logEntry } from '../operation-log';
import { CHANGED_MEANWHILE, TASK_NOT_FOUND, TASK_NOT_REOPENABLE } from '../task-failures';
import { TasksAccess } from '../tasks-access';
import { TasksJournal } from '../tasks-journal';

/**
 * Reopen an archived or cancelled task (roadmap §15): back among the active
 * tasks, its whole history kept, who reopened it and when logged.
 */
@Injectable()
export class ReopenTaskUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
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
    if (!isReopenable(task)) return err(TASK_NOT_REOPENABLE);

    const now = this.clock.now();
    const actorId = command.principal.userId;
    const next = reopen(task, now);
    const changed = await this.tasks.changeLifecycle(
      next,
      task,
      logEntry('TASK_REOPENED', task.id, actorId, now, {
        detail: { wasCancelled: task.status === 'CANCELLED' },
      }),
    );
    if (!changed) return err(CHANGED_MEANWHILE);
    await this.journal.record({
      actorUserId: actorId,
      action: 'tasks.task.reopened',
      resourceType: 'task',
      resourceId: task.id,
      at: now,
    });
    return ok(next);
  }
}

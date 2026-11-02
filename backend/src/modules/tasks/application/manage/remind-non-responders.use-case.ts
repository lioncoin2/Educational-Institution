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
  TASK_EVENT_LOG,
  TASK_REPOSITORY,
  type AssignmentRepository,
  type TaskEventLog,
  type TaskRepository,
} from '../../domain/ports';
import { isActive } from '../../domain/task';
import { logEntry } from '../operation-log';
import { TASK_NOT_ACTIVE, TASK_NOT_FOUND } from '../task-failures';
import { TasksAccess } from '../tasks-access';
import { TasksJournal } from '../tasks-journal';

/**
 * "تذكير غير المستجيبين" (roadmap §4): the task is sent again to the addressees
 * who have not responded at all — never to someone who acknowledged. There is no
 * reminder for "acknowledged but not completed" (§17).
 */
@Injectable()
export class RemindNonRespondersUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepository,
    @Inject(TASK_EVENT_LOG) private readonly log: TaskEventLog,
    private readonly journal: TasksJournal,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly taskId: string;
  }): Promise<Result<{ readonly reminded: number }>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const task = await this.tasks.findById(command.taskId);
    if (task === null) return err(TASK_NOT_FOUND);
    if (!isActive(task)) return err(TASK_NOT_ACTIVE);

    const silent = await this.assignments.nonResponders(task.id);
    if (silent.length === 0) return ok({ reminded: 0 });
    const now = this.clock.now();
    const actorId = command.principal.userId;
    await this.log.append(
      logEntry('TASK_REMINDED', task.id, actorId, now, { detail: { reminded: silent.length } }),
    );
    await this.journal.record(
      {
        actorUserId: actorId,
        action: 'tasks.task.reminded',
        resourceType: 'task',
        resourceId: task.id,
        at: now,
        metadata: { reminded: silent.length },
      },
      [
        domainEvent(
          TasksEvents.reminded,
          task.id,
          { taskId: task.id, actorId, recipientUserIds: silent.map((a) => a.recipientId) },
          now,
        ),
      ],
    );
    return ok({ reminded: silent.length });
  }
}

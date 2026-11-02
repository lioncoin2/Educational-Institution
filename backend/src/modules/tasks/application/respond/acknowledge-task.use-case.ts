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
  acknowledgementCompletes,
  checkAcknowledge,
  type Assignment,
} from '../../domain/assignment';
import {
  ASSIGNMENT_REPOSITORY,
  TASK_REPOSITORY,
  type AssignmentRepository,
  type TaskRepository,
} from '../../domain/ports';
import { isActive } from '../../domain/task';
import { logEntry } from '../operation-log';
import { CHANGED_MEANWHILE, TASK_NOT_ACTIVE } from '../task-failures';
import { TasksJournal } from '../tasks-journal';
import { OwnTaskLoader } from './own-task';

/**
 * "تم استلام المهمة" (roadmap §3): records who and when; a repeat changes
 * nothing. When the task has no complete button and no report, acknowledging is
 * completing it.
 */
@Injectable()
export class AcknowledgeTaskUseCase {
  constructor(
    private readonly own: OwnTaskLoader,
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepository,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    private readonly journal: TasksJournal,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly assignmentId: string;
  }): Promise<Result<Assignment>> {
    const loaded = await this.own.load(command.principal, command.assignmentId);
    if (!loaded.ok) return loaded;
    const { assignment, task } = loaded.value;
    const check = checkAcknowledge(assignment, task);
    if (!check.ok) return check;
    if (check.value === 'already') return ok(assignment);
    // A repeat is answered as it stands, even once the task has moved on;
    // only a new act needs an active task.
    if (!isActive(task)) return err(TASK_NOT_ACTIVE);

    const now = this.clock.now();
    const completes = acknowledgementCompletes(task);
    const next: Assignment = {
      ...assignment,
      status: completes ? 'COMPLETED' : 'ACKNOWLEDGED',
      acknowledgedAt: now,
      acknowledgedRevision: task.revision,
      completedAt: completes ? now : null,
    };
    const actorId = command.principal.userId;
    const stored = await this.assignments.acknowledge(
      next,
      logEntry(
        completes ? 'ASSIGNMENT_COMPLETED' : 'ASSIGNMENT_ACKNOWLEDGED',
        task.id,
        actorId,
        now,
        {
          assignmentId: assignment.id,
          detail: { revision: task.revision },
        },
      ),
    );
    if (!stored) return err(CHANGED_MEANWHILE);
    const fact = {
      taskId: task.id,
      assignmentId: assignment.id,
      recipientId: actorId,
      publisherId: task.createdBy,
    };
    await this.journal.record(
      {
        actorUserId: actorId,
        action: 'tasks.assignment.acknowledged',
        resourceType: 'task',
        resourceId: task.id,
        at: now,
        metadata: { assignmentId: assignment.id, completes },
      },
      [
        domainEvent(
          completes ? TasksEvents.completed : TasksEvents.acknowledged,
          task.id,
          fact,
          now,
        ),
      ],
    );
    if (completes) await this.tasks.archiveIfSettled(task.id, now);
    return ok(next);
  }
}

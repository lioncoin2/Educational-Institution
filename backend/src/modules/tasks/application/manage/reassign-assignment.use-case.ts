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
import type { Assignment } from '../../domain/assignment';
import {
  ASSIGNMENT_REPOSITORY,
  TASK_REPOSITORY,
  type AssignmentRepository,
  type TaskRepository,
} from '../../domain/ports';
import { isActive } from '../../domain/task';
import { AudienceResolver } from '../audience-resolver';
import { logEntry } from '../operation-log';
import {
  ASSIGNMENT_NOT_PENDING,
  REASSIGN_TARGET_INVALID,
  TASK_NOT_ACTIVE,
  TASK_NOT_FOUND,
} from '../task-failures';
import { TasksAccess } from '../tasks-access';
import { TasksJournal } from '../tasks-journal';

export interface ReassignCommand {
  readonly principal: Principal;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly toUserId: string;
}

/**
 * Hand a pending task to another member of its audience (roadmap §11) — when its
 * holder left or their account was disabled. The previous holder, their
 * responses, who reassigned and when are all kept; the new holder is told.
 */
@Injectable()
export class ReassignAssignmentUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepository,
    private readonly audience: AudienceResolver,
    private readonly journal: TasksJournal,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: ReassignCommand): Promise<Result<Assignment>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const task = await this.tasks.findById(command.taskId);
    if (task === null) return err(TASK_NOT_FOUND);
    if (!isActive(task)) return err(TASK_NOT_ACTIVE);
    const current = await this.assignments.findById(command.assignmentId);
    if (current === null || current.taskId !== task.id) return err(TASK_NOT_FOUND);
    if (current.status === 'COMPLETED' || current.status === 'REASSIGNED') {
      return err(ASSIGNMENT_NOT_PENDING);
    }
    const toUserId = command.toUserId.trim();
    const audience =
      toUserId === current.recipientId
        ? null
        : await this.audience.audienceOf(toUserId, task.audiences, task.communityId);
    if (audience === null) return err(REASSIGN_TARGET_INVALID);

    const now = this.clock.now();
    const actorId = command.principal.userId;
    const opened: Assignment = {
      id: this.ids.next<'TaskAssignment'>(),
      taskId: task.id,
      recipientId: toUserId,
      audience,
      status: 'PENDING',
      acknowledgedAt: null,
      acknowledgedRevision: null,
      completedAt: null,
      createdAt: now,
      reassignedTo: null,
      reassignedAt: null,
      reassignedBy: null,
      replaces: current.id,
    };
    const closed: Assignment = {
      ...current,
      status: 'REASSIGNED',
      reassignedTo: opened.id,
      reassignedAt: now,
      reassignedBy: actorId,
    };
    const moved = await this.assignments.reassign(
      closed,
      opened,
      logEntry('ASSIGNMENT_REASSIGNED', task.id, actorId, now, {
        assignmentId: current.id,
        detail: { to: opened.id },
      }),
    );
    if (!moved) return err(REASSIGN_TARGET_INVALID);
    await this.journal.record(
      {
        actorUserId: actorId,
        action: 'tasks.assignment.reassigned',
        resourceType: 'task',
        resourceId: task.id,
        at: now,
        metadata: { from: current.id, to: opened.id },
      },
      [
        domainEvent(
          TasksEvents.reassigned,
          task.id,
          {
            taskId: task.id,
            actorId,
            previousRecipientId: current.recipientId,
            newRecipientId: toUserId,
          },
          now,
        ),
      ],
    );
    return ok(opened);
  }
}

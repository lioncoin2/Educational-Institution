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
} from '../../../shared';
import { TasksEvents } from '../contracts';
import type { Assignment } from '../domain/assignment';
import type { TaskAudience } from '../domain/audience';
import { TASK_REPOSITORY, type PublishOutcome, type TaskRepository } from '../domain/ports';
import type { Task } from '../domain/task';
import { AudienceResolver } from './audience-resolver';
import { logEntry } from './operation-log';
import { NO_RECIPIENTS } from './task-failures';
import type { TaskDraft } from './task-draft';
import { TasksJournal } from './tasks-journal';

export interface PublishRequest {
  readonly principal: Principal;
  readonly draft: TaskDraft;
  readonly audiences: readonly TaskAudience[];
  readonly communityId: string | null;
  readonly templateId: string | null;
  readonly republishedFrom: string | null;
  readonly clientRequestId: string | null;
}

/**
 * Publishing a new, independent task (ADR 0052 §2, §8) — shared by a fresh
 * publish, a publish from a template and a re-publish. Resolves and snapshots
 * the addressees, stores the task with them atomically, then journals it. An
 * idempotent retry returns the first task and journals nothing again.
 * Authorization is the calling use case's: this only publishes.
 */
@Injectable()
export class TaskPublisher {
  constructor(
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    private readonly audience: AudienceResolver,
    private readonly journal: TasksJournal,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async publish(request: PublishRequest): Promise<Result<PublishOutcome>> {
    const publisherId = request.principal.userId;
    const addressees = await this.audience.resolve(
      request.audiences,
      request.communityId,
      publisherId,
    );
    if (!addressees.ok) return addressees;
    if (addressees.value.length === 0) return err(NO_RECIPIENTS);

    const now = this.clock.now();
    const task: Task = {
      id: this.ids.next<'Task'>(),
      ...request.draft.content,
      ...request.draft.settings,
      audiences: request.audiences,
      communityId: request.communityId,
      revision: 1,
      status: 'OPEN',
      createdBy: publisherId,
      createdAt: now,
      updatedAt: now,
      cancelledAt: null,
      cancelledBy: null,
      archivedAt: null,
      templateId: request.templateId,
      republishedFrom: request.republishedFrom,
    };
    const assignments: Assignment[] = addressees.value.map(({ recipientId, audience }) => ({
      id: this.ids.next<'TaskAssignment'>(),
      taskId: task.id,
      recipientId,
      audience,
      status: 'PENDING',
      acknowledgedAt: null,
      acknowledgedRevision: null,
      completedAt: null,
      createdAt: now,
      reassignedTo: null,
      reassignedAt: null,
      reassignedBy: null,
      replaces: null,
    }));
    const outcome = await this.tasks.publish({
      task,
      assignments,
      clientRequestId: request.clientRequestId,
      event: logEntry('TASK_PUBLISHED', task.id, publisherId, now, {
        detail: { recipients: assignments.length },
      }),
    });
    if (outcome.status === 'created') {
      await this.journal.record(
        {
          actorUserId: publisherId,
          action: 'tasks.task.published',
          resourceType: 'task',
          resourceId: task.id,
          at: now,
          metadata: { recipients: assignments.length, audiences: [...task.audiences] },
        },
        [
          domainEvent(
            TasksEvents.published,
            task.id,
            {
              taskId: task.id,
              actorId: publisherId,
              recipientUserIds: assignments.map((a) => a.recipientId),
            },
            now,
          ),
        ],
      );
    }
    return ok(outcome);
  }
}

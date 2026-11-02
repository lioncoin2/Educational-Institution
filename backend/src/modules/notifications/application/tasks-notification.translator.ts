import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import {
  EVENT_SUBSCRIBER,
  type DomainEvent,
  type EventSubscriber,
  type Unsubscribe,
} from '../../../shared';
import { TasksEvents } from '../../tasks/contracts';
import type { NotificationType } from '../contracts/vocabulary';
import { bodyKeyOf, titleKeyOf } from '../domain/catalog';
import type { NotificationRequest } from '../domain/notification';
import { NotificationDispatcher } from './notification-dispatcher';

/** Requests per dispatch call when a task reaches a large audience. */
const DISPATCH_BATCH = 500;

/**
 * The daily tasks engine's facts (ADR 0052 §11), translated into notifications —
 * the only code in this module that knows the tasks engine exists.
 *
 *   tasks.task.published / updated / cancelled / reminded   the addressees named
 *   tasks.assignment.reassigned                             the new holder
 *   tasks.assignment.acknowledged / completed               the publisher (grouped)
 *   tasks.report.submitted (first / again)                  the publisher (grouped)
 *   tasks.report.changes_requested / approved               the report's author
 *
 * Ids only: the target names the task; the client opens it with the reader's own
 * authorization. Responses to the publisher are GROUPED to one notification per
 * task, type and hour (the dedupe key names the hour), so a staff of hundreds
 * answering does not bury the publisher. Nobody is told of their own act.
 * Chained per task, detached from the publisher; a malformed payload is logged
 * and ignored, never thrown.
 */
@Injectable()
export class TasksNotificationTranslator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TasksNotificationTranslator.name);
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  onModuleInit(): void {
    for (const name of Object.values(TasksEvents)) {
      this.unsubscribes.push(this.subscriber.subscribe(name, (event) => this.schedule(event)));
    }
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  /** Queues translation behind the task's earlier facts, and returns at once. */
  schedule(event: DomainEvent): void {
    const key = event.aggregateId;
    const next = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.translate(event))
      .catch((error: unknown) =>
        this.logger.error(
          { event: event.name, aggregateId: event.aggregateId, err: error },
          'notification translation failed',
        ),
      );
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  /** Resolves once everything scheduled so far is translated — for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /** Translates one fact now. */
  async translate(event: DomainEvent): Promise<void> {
    const requests = requestsFor(event);
    if (requests === null) {
      this.logger.warn({ event: event.name }, 'ignoring a malformed tasks event');
      return;
    }
    for (let start = 0; start < requests.length; start += DISPATCH_BATCH) {
      await this.dispatcher.dispatch(
        requests.slice(start, start + DISPATCH_BATCH),
        event.correlationId,
      );
    }
  }
}

/** The notifications one fact produces; null when its payload is malformed. */
function requestsFor(event: DomainEvent): NotificationRequest[] | null {
  const p = fields(event.payload);
  if (p === null || typeof p.taskId !== 'string') return null;
  const taskId = p.taskId;
  const at = event.occurredAt.getTime();
  const hour = event.occurredAt.toISOString().slice(0, 13);

  const toAddressees = (type: NotificationType, tag: string): NotificationRequest[] | null => {
    if (!isIdList(p.recipientUserIds) || typeof p.actorId !== 'string') return null;
    return p.recipientUserIds
      .filter((id) => id !== p.actorId)
      .map((id) => request(type, id, 'assigned_task', taskId, `task:${taskId}:${tag}:user:${id}`));
  };
  const toPublisher = (type: NotificationType): NotificationRequest[] | null => {
    const publisher = p.publisherId;
    const actor = typeof p.recipientId === 'string' ? p.recipientId : p.authorId;
    if (typeof publisher !== 'string') return null;
    if (publisher === actor) return [];
    return [
      request(type, publisher, 'task', taskId, `task:${taskId}:${type}:${hour}:user:${publisher}`),
    ];
  };
  const toAuthor = (type: NotificationType): NotificationRequest[] | null => {
    if (typeof p.authorId !== 'string' || typeof p.reportId !== 'string') return null;
    if (p.authorId === p.reviewerId) return [];
    return [
      request(
        type,
        p.authorId,
        'assigned_task',
        taskId,
        `task:${taskId}:report:${p.reportId}:${type}:${at}`,
      ),
    ];
  };

  switch (event.name) {
    case TasksEvents.published:
      return toAddressees('TASK_PUBLISHED', 'published');
    case TasksEvents.updated:
      return toAddressees('TASK_UPDATED', `updated:${at}`);
    case TasksEvents.cancelled:
      return toAddressees('TASK_CANCELLED', `cancelled:${at}`);
    case TasksEvents.reminded:
      return toAddressees('TASK_REMINDER', `reminder:${at}`);
    case TasksEvents.reassigned:
      if (typeof p.newRecipientId !== 'string') return null;
      return [
        request(
          'TASK_REASSIGNED',
          p.newRecipientId,
          'assigned_task',
          taskId,
          `task:${taskId}:reassigned:user:${p.newRecipientId}`,
        ),
      ];
    case TasksEvents.acknowledged:
      return toPublisher('TASK_ACKNOWLEDGED');
    case TasksEvents.completed:
      return toPublisher('TASK_COMPLETED');
    case TasksEvents.reportSubmitted:
      return toPublisher(
        p.resubmission === true ? 'TASK_REPORT_RESUBMITTED' : 'TASK_REPORT_SUBMITTED',
      );
    case TasksEvents.reportChangesRequested:
      return toAuthor('TASK_REPORT_CHANGES_REQUESTED');
    case TasksEvents.reportApproved:
      return toAuthor('TASK_REPORT_APPROVED');
    default:
      return [];
  }
}

function request(
  type: NotificationType,
  recipientUserId: string,
  kind: 'task' | 'assigned_task',
  taskId: string,
  dedupeKey: string,
): NotificationRequest {
  return {
    recipientUserId,
    type,
    titleKey: titleKeyOf(type),
    bodyKey: bodyKeyOf(type),
    params: {},
    target: { kind, taskId },
    dedupeKey,
  };
}

// Events cross a module boundary: their shape is checked, not assumed.

function fields(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === 'object'
    ? (payload as Record<string, unknown>)
    : null;
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string');
}

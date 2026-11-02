import { domainEvent, type EventSubscriber } from '../../../shared';
import { TasksEvents } from '../../tasks/contracts';
import type { NotificationRequest } from '../domain/notification';
import type { NotificationDispatcher } from './notification-dispatcher';
import { TasksNotificationTranslator } from './tasks-notification.translator';

function translator() {
  const sent: NotificationRequest[] = [];
  const dispatcher = {
    dispatch: async (requests: readonly NotificationRequest[]) => void sent.push(...requests),
  } as unknown as NotificationDispatcher;
  const subscriber: EventSubscriber = { subscribe: () => () => undefined };
  return { sent, subject: new TasksNotificationTranslator(subscriber, dispatcher) };
}

const at = new Date('2026-11-02T09:15:00.000Z');

describe('tasks notifications (ADR 0052 §11)', () => {
  it('tells every addressee of a published task — never its publisher — and leads to their task', async () => {
    const { sent, subject } = translator();
    await subject.translate(
      domainEvent(
        TasksEvents.published,
        't1',
        { taskId: 't1', actorId: 'admin', recipientUserIds: ['u1', 'u2', 'admin'] },
        at,
      ),
    );
    expect(sent.map((r) => [r.recipientUserId, r.type, r.target])).toEqual([
      ['u1', 'TASK_PUBLISHED', { kind: 'assigned_task', taskId: 't1' }],
      ['u2', 'TASK_PUBLISHED', { kind: 'assigned_task', taskId: 't1' }],
    ]);
  });

  it('groups responses to the publisher into one notification per task, type and hour', async () => {
    const { sent, subject } = translator();
    const ack = (recipientId: string, when: Date) =>
      domainEvent(
        TasksEvents.acknowledged,
        't1',
        { taskId: 't1', assignmentId: `a-${recipientId}`, recipientId, publisherId: 'owner' },
        when,
      );
    await subject.translate(ack('u1', at));
    await subject.translate(ack('u2', new Date('2026-11-02T09:40:00.000Z')));
    await subject.translate(ack('u3', new Date('2026-11-02T10:05:00.000Z')));
    const keys = sent.map((r) => r.dedupeKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(sent.every((r) => r.recipientUserId === 'owner' && r.target.kind === 'task')).toBe(true);
  });

  it('tells a report’s author of a decision, unless they decided it themselves', async () => {
    const { sent, subject } = translator();
    await subject.translate(
      domainEvent(
        TasksEvents.reportChangesRequested,
        't1',
        { taskId: 't1', reportId: 'r1', authorId: 'u1', reviewerId: 'admin' },
        at,
      ),
    );
    await subject.translate(
      domainEvent(
        TasksEvents.reportApproved,
        't1',
        { taskId: 't1', reportId: 'r2', authorId: 'admin', reviewerId: 'admin' },
        at,
      ),
    );
    expect(sent.map((r) => [r.recipientUserId, r.type])).toEqual([
      ['u1', 'TASK_REPORT_CHANGES_REQUESTED'],
    ]);
  });

  it('distinguishes a resubmitted report and ignores a malformed fact', async () => {
    const { sent, subject } = translator();
    await subject.translate(
      domainEvent(
        TasksEvents.reportSubmitted,
        't1',
        { taskId: 't1', reportId: 'r1', authorId: 'u1', publisherId: 'owner', resubmission: true },
        at,
      ),
    );
    await subject.translate(domainEvent(TasksEvents.published, 't1', { taskId: 't1' }, at));
    expect(sent.map((r) => r.type)).toEqual(['TASK_REPORT_RESUBMITTED']);
  });
});

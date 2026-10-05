import {
  domainEvent,
  type AuditEntry,
  type AuditLog,
  type DomainEvent,
  type EventPublisher,
} from '../../../shared';
import { AttendanceJournal } from './attendance-journal';

class FakeAudit implements AuditLog {
  readonly entries: AuditEntry[] = [];
  constructor(private readonly order: string[]) {}
  record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    this.order.push('audit');
    return Promise.resolve();
  }
}

class FakeEvents implements EventPublisher {
  readonly published: DomainEvent[] = [];
  constructor(private readonly order: string[]) {}
  publish(events: readonly DomainEvent[]): Promise<void> {
    this.published.push(...events);
    this.order.push('event');
    return Promise.resolve();
  }
}

describe('AttendanceJournal', () => {
  it('records the audit entry, then publishes the event — in that order', async () => {
    const order: string[] = [];
    const audit = new FakeAudit(order);
    const events = new FakeEvents(order);
    const journal = new AttendanceJournal(audit, events);

    const entry: AuditEntry = {
      actorUserId: 'rec-1',
      action: 'attendance.snapshot.recorded',
      resourceType: 'attendance.snapshot',
      resourceId: 'snap-1',
      at: new Date(0),
    };
    const event = domainEvent(
      'attendance.snapshot.recorded',
      's-1',
      { snapshotId: 'snap-1' },
      new Date(0),
    );

    await journal.record(entry, event);

    expect(order).toEqual(['audit', 'event']);
    expect(audit.entries).toEqual([entry]);
    expect(events.published).toEqual([event]);
  });
});

import { checkAcknowledge, checkComplete, hasResponded, type Assignment } from './assignment';
import type { TaskSettings } from './task-config';

const at = new Date('2026-11-02T08:00:00Z');
const pending: Assignment = {
  id: 'a1',
  taskId: 't1',
  recipientId: 'u1',
  audience: 'TEACHERS',
  status: 'PENDING',
  acknowledgedAt: null,
  acknowledgedRevision: null,
  completedAt: null,
  createdAt: at,
  reassignedTo: null,
  reassignedAt: null,
  reassignedBy: null,
  replaces: null,
};
const both: TaskSettings = {
  kind: 'GENERAL',
  buttons: ['ACKNOWLEDGE', 'COMPLETE'],
  reportRequired: false,
  approvalMode: 'AUTO',
};

describe('assignment transitions', () => {
  it('acknowledges once; a repeat is a no-op, not an error', () => {
    expect(checkAcknowledge(pending, both)).toEqual({ ok: true, value: 'acknowledge' });
    const acked = { ...pending, status: 'ACKNOWLEDGED' as const, acknowledgedAt: at };
    expect(checkAcknowledge(acked, both)).toEqual({ ok: true, value: 'already' });
  });

  it('needs acknowledgement before completion when the task has the button', () => {
    const refused = checkComplete(pending, both, 'button');
    expect(!refused.ok && refused.error.code).toBe('tasks.acknowledge_first');
    const acked = { ...pending, status: 'ACKNOWLEDGED' as const, acknowledgedAt: at };
    expect(checkComplete(acked, both, 'button')).toEqual({ ok: true, value: 'complete' });
  });

  it('completes by the method the task was published with', () => {
    const reportOnly: TaskSettings = { ...both, buttons: [], reportRequired: true };
    const byButton = checkComplete(pending, reportOnly, 'button');
    expect(!byButton.ok && byButton.error.code).toBe('tasks.no_complete_button');
    expect(checkComplete(pending, reportOnly, 'report')).toEqual({ ok: true, value: 'complete' });
    const ackOnly: TaskSettings = { ...both, buttons: ['ACKNOWLEDGE'] };
    const viaAck = checkComplete(pending, ackOnly, 'button');
    expect(!viaAck.ok && viaAck.error.code).toBe('tasks.complete_by_acknowledge');
  });

  it('refuses every response on a handed-over assignment', () => {
    const closed = { ...pending, status: 'REASSIGNED' as const };
    const ack = checkAcknowledge(closed, both);
    expect(!ack.ok && ack.error.code).toBe('tasks.assignment_closed');
  });

  it('counts any response as having responded', () => {
    expect(hasResponded(pending)).toBe(false);
    expect(hasResponded({ ...pending, acknowledgedAt: at })).toBe(true);
    expect(hasResponded({ ...pending, completedAt: at })).toBe(true);
  });
});

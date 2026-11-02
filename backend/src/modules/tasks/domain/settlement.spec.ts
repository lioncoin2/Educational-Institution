import type { Assignment } from './assignment';
import type { Report } from './report';
import { isTaskSettled } from './settlement';
import type { Task } from './task';

const at = new Date('2026-11-02T08:00:00Z');
const task: Task = {
  id: 't1',
  title: 'x',
  body: '',
  kind: 'GENERAL',
  buttons: ['COMPLETE'],
  reportRequired: true,
  approvalMode: 'MANUAL',
  audiences: ['TEACHERS'],
  communityId: null,
  revision: 1,
  status: 'OPEN',
  createdBy: 'owner',
  createdAt: at,
  updatedAt: at,
  cancelledAt: null,
  cancelledBy: null,
  archivedAt: null,
  templateId: null,
  republishedFrom: null,
};
const assignment = (id: string, over: Partial<Assignment> = {}): Assignment => ({
  id,
  taskId: 't1',
  recipientId: `u-${id}`,
  audience: 'TEACHERS',
  status: 'COMPLETED',
  acknowledgedAt: null,
  acknowledgedRevision: null,
  completedAt: at,
  createdAt: at,
  reassignedTo: null,
  reassignedAt: null,
  reassignedBy: null,
  replaces: null,
  ...over,
});
const report = (assignmentId: string, status: Report['status']): Report => ({
  id: `r-${assignmentId}`,
  taskId: 't1',
  assignmentId,
  authorId: 'u',
  category: 'TASK_COMPLETION',
  status,
  version: 1,
  submittedAt: at,
  updatedAt: at,
  approvedAt: null,
  approvedBy: null,
  deletedAt: null,
  deletedBy: null,
});

describe('the archive rule', () => {
  it('settles when every holder completed and every required report is approved', () => {
    const reports = new Map([
      ['a1', report('a1', 'APPROVED')],
      ['a2', report('a2', 'APPROVED')],
    ]);
    expect(isTaskSettled(task, [assignment('a1'), assignment('a2')], reports)).toBe(true);
  });

  it('waits for a pending, sent-back or deleted report', () => {
    for (const status of ['PENDING_REVIEW', 'CHANGES_REQUESTED', 'DELETED'] as const) {
      const reports = new Map([['a1', report('a1', status)]]);
      expect(isTaskSettled(task, [assignment('a1')], reports)).toBe(false);
    }
  });

  it('ignores the handed-over assignment and waits for whoever took it over', () => {
    const closed = assignment('a1', { status: 'REASSIGNED', completedAt: null });
    const taken = assignment('a2', { status: 'PENDING', completedAt: null });
    expect(isTaskSettled(task, [closed, taken], new Map())).toBe(false);
    const reports = new Map([['a2', report('a2', 'APPROVED')]]);
    expect(isTaskSettled(task, [closed, assignment('a2')], reports)).toBe(true);
  });

  it('never settles a cancelled, archived or empty task', () => {
    const reports = new Map([['a1', report('a1', 'APPROVED')]]);
    expect(isTaskSettled({ ...task, status: 'CANCELLED' }, [assignment('a1')], reports)).toBe(
      false,
    );
    expect(isTaskSettled({ ...task, archivedAt: at }, [assignment('a1')], reports)).toBe(false);
    expect(isTaskSettled(task, [], reports)).toBe(false);
  });
});

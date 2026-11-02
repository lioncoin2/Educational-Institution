import {
  checkReview,
  normaliseReportBody,
  normaliseReviewNote,
  statusAfterWriting,
  type Report,
} from './report';

const at = new Date('2026-11-02T08:00:00Z');
const report: Report = {
  id: 'r1',
  taskId: 't1',
  assignmentId: 'a1',
  authorId: 'u1',
  category: 'TASK_COMPLETION',
  status: 'PENDING_REVIEW',
  version: 2,
  submittedAt: at,
  updatedAt: at,
  approvedAt: null,
  approvedBy: null,
  deletedAt: null,
  deletedBy: null,
};

describe('report rules', () => {
  it('approves at once in AUTO mode and waits for the administration in MANUAL', () => {
    expect(statusAfterWriting('AUTO')).toBe('APPROVED');
    expect(statusAfterWriting('MANUAL')).toBe('PENDING_REVIEW');
  });

  it('decides only about the version the reviewer read, and only while pending', () => {
    const stale = checkReview(report, 1);
    expect(!stale.ok && stale.error.code).toBe('tasks.report_version_conflict');
    expect(checkReview(report, 2).ok).toBe(true);
    const approved = checkReview({ ...report, status: 'APPROVED' }, 2);
    expect(!approved.ok && approved.error.code).toBe('tasks.report_not_pending');
  });

  it('requires report text, and a reason when changes are requested', () => {
    const blank = normaliseReportBody('  ');
    expect(!blank.ok && blank.error.code).toBe('tasks.report_required');
    const noReason = normaliseReviewNote('', true);
    expect(!noReason.ok && noReason.error.code).toBe('tasks.note_required');
    expect(normaliseReviewNote('', false)).toEqual({ ok: true, value: null });
  });
});

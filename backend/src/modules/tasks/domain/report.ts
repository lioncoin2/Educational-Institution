import { err, failure, ok, type Result } from '../../../shared';
import type { ApprovalMode, ReportCategory } from './task-config';

/**
 * One assignment's written report and its review (ADR 0052 §5; roadmap §5–§7).
 *
 *   PENDING_REVIEW ──approve──▶ APPROVED
 *         │                        │ (edited)
 *         └─request changes─▶ CHANGES_REQUESTED ──(edited)──▶ PENDING_REVIEW
 *   any ──(deleted by owner/admin)──▶ DELETED ──(submitted again)──▶ PENDING_REVIEW
 *
 * In AUTO mode every submitted version is approved at once (no reviewer). Every
 * version and every review decision is kept; nothing is overwritten.
 */
export const REPORT_STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'CHANGES_REQUESTED',
  'DELETED',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_BODY_MAX = 20_000;
export const REVIEW_NOTE_MAX = 2_000;

export interface Report {
  readonly id: string;
  readonly taskId: string;
  readonly assignmentId: string;
  readonly authorId: string;
  readonly category: ReportCategory;
  readonly status: ReportStatus;
  /** The latest version's number (1-based). */
  readonly version: number;
  readonly submittedAt: Date;
  readonly updatedAt: Date;
  /** Who approved the current version, and when; approver null = approved automatically. */
  readonly approvedAt: Date | null;
  readonly approvedBy: string | null;
  readonly deletedAt: Date | null;
  readonly deletedBy: string | null;
}

export interface ReportVersion {
  readonly reportId: string;
  readonly version: number;
  readonly body: string;
  readonly editedBy: string;
  readonly editedAt: Date;
}

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED';

export interface ReportReview {
  readonly id: string;
  readonly reportId: string;
  readonly version: number;
  readonly decision: ReviewDecision;
  readonly note: string | null;
  readonly reviewerId: string;
  readonly decidedAt: Date;
}

/** The status a newly written version lands in: approved at once in AUTO mode. */
export function statusAfterWriting(mode: ApprovalMode): ReportStatus {
  return mode === 'AUTO' ? 'APPROVED' : 'PENDING_REVIEW';
}

/** A report that counts toward settling the task: approved and not deleted. */
export function isSettled(report: Report): boolean {
  return report.status === 'APPROVED';
}

/**
 * A review decides about the version the reviewer read: a stale version is a
 * conflict (the author edited meanwhile), and only a pending report is decided.
 */
export function checkReview(report: Report, version: number): Result<void> {
  if (report.version !== version) {
    return err(
      failure('conflict', 'tasks.report_version_conflict', 'The report changed; read it again.', {
        current: report.version,
      }),
    );
  }
  if (report.status !== 'PENDING_REVIEW') {
    return err(
      failure(
        'precondition_failed',
        'tasks.report_not_pending',
        'This report is not awaiting review.',
        {
          status: report.status,
        },
      ),
    );
  }
  return ok(undefined);
}

/** Trimmed report text, required and bounded. */
export function normaliseReportBody(body: string): Result<string> {
  const trimmed = body.trim();
  if (trimmed === '') {
    return err(failure('validation', 'tasks.report_required', 'Write the report.'));
  }
  if ([...trimmed].length > REPORT_BODY_MAX) {
    return err(
      failure(
        'validation',
        'tasks.report_too_long',
        `A report may be at most ${REPORT_BODY_MAX}.`,
        {
          max: REPORT_BODY_MAX,
        },
      ),
    );
  }
  return ok(trimmed);
}

/** An optional reviewer note; a request for changes must explain itself. */
export function normaliseReviewNote(
  note: string | null | undefined,
  required: boolean,
): Result<string | null> {
  const trimmed = (note ?? '').trim();
  if (trimmed === '') {
    return required
      ? err(failure('validation', 'tasks.note_required', 'Say what should change.'))
      : ok(null);
  }
  if ([...trimmed].length > REVIEW_NOTE_MAX) {
    return err(
      failure('validation', 'tasks.note_too_long', `A note may be at most ${REVIEW_NOTE_MAX}.`, {
        max: REVIEW_NOTE_MAX,
      }),
    );
  }
  return ok(trimmed);
}

/** A report's first version, as its author submits it (approved at once in AUTO mode). */
export function firstReport(
  base: Pick<Report, 'id' | 'taskId' | 'assignmentId' | 'authorId' | 'category'>,
  mode: ApprovalMode,
  at: Date,
): Report {
  const status = statusAfterWriting(mode);
  return {
    ...base,
    status,
    version: 1,
    submittedAt: at,
    updatedAt: at,
    approvedAt: status === 'APPROVED' ? at : null,
    approvedBy: null,
    deletedAt: null,
    deletedBy: null,
  };
}

/**
 * The report after a new version is written — by its author or by the
 * administration. It goes back to review (or straight to approved in AUTO mode),
 * a deletion is undone, and the previous approval no longer stands.
 */
export function withNewVersion(report: Report, mode: ApprovalMode, at: Date): Report {
  const status = statusAfterWriting(mode);
  return {
    ...report,
    status,
    version: report.version + 1,
    updatedAt: at,
    approvedAt: status === 'APPROVED' ? at : null,
    approvedBy: null,
    deletedAt: null,
    deletedBy: null,
  };
}

/** The report after a review decision about its current version. */
export function decided(report: Report, decision: ReviewDecision, by: string, at: Date): Report {
  return decision === 'APPROVED'
    ? { ...report, status: 'APPROVED', approvedAt: at, approvedBy: by, updatedAt: at }
    : { ...report, status: 'CHANGES_REQUESTED', approvedAt: null, approvedBy: null, updatedAt: at };
}

/** Deleted by the administration: hidden from the lists, every version kept. */
export function softDeleted(report: Report, by: string, at: Date): Report {
  return {
    ...report,
    status: 'DELETED',
    approvedAt: null,
    approvedBy: null,
    deletedAt: at,
    deletedBy: by,
    updatedAt: at,
  };
}

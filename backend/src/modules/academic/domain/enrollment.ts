import type { Id } from '../../../shared/identifier';
import { err, failure, ok, type Result } from '../../../shared/result';
import type { EnrollmentOutcome, EnrollmentStatus } from '../contracts/vocabulary';
import type { HalaqaId } from './structure';

export type EnrollmentId = Id<'AcademicEnrollment'>;

/**
 * The authoritative record that a student account belongs to a halaqa.
 *
 * Academic status is not account status: an account may be ACTIVE and its
 * enrollment WITHDRAWN, or the account suspended while the enrollment stays
 * ACTIVE — identity and academic answer different questions.
 *
 * Never deleted. It ends — COMPLETED or WITHDRAWN, as someone decides — and
 * stays as history; enrolling the same person again makes a new record.
 */
export interface Enrollment {
  readonly id: EnrollmentId;
  readonly studentUserId: string;
  readonly halaqaId: HalaqaId;
  readonly status: EnrollmentStatus;
  readonly enrolledAt: Date;
  /** The account that enrolled them; null for a system action. */
  readonly enrolledBy: string | null;
  readonly endedAt: Date | null;
  readonly endedBy: string | null;
  readonly updatedAt: Date;
}

export function newEnrollment(input: {
  readonly id: EnrollmentId;
  readonly studentUserId: string;
  readonly halaqaId: HalaqaId;
  readonly enrolledBy: string | null;
  readonly at: Date;
}): Enrollment {
  return {
    id: input.id,
    studentUserId: input.studentUserId,
    halaqaId: input.halaqaId,
    status: 'ACTIVE',
    enrolledAt: input.at,
    enrolledBy: input.enrolledBy,
    endedAt: null,
    endedBy: null,
    updatedAt: input.at,
  };
}

/** The ACTIVE → outcome transition, as data — applied atomically by the repository. */
export function ended(
  enrollment: Enrollment,
  outcome: EnrollmentOutcome,
  by: string | null,
  at: Date,
): Enrollment {
  // Another instance's clock may run behind: an enrollment never ends before it began.
  const endedAt = at < enrollment.enrolledAt ? enrollment.enrolledAt : at;
  return { ...enrollment, status: outcome, endedAt, endedBy: by, updatedAt: endedAt };
}

/**
 * Asked to end an enrollment that is no longer ACTIVE. Ending it the same
 * way again is a retry and succeeds without changing anything; ending it
 * another way would rewrite history, and is refused.
 */
export function alreadyEnded(
  enrollment: Enrollment,
  outcome: EnrollmentOutcome,
): Result<Enrollment> {
  if (enrollment.status === outcome) return ok(enrollment);
  return err(
    failure(
      'conflict',
      'academic.enrollment_already_ended',
      'This enrollment has already ended another way.',
      { status: enrollment.status },
    ),
  );
}

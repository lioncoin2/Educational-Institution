import type { Id } from '../../../shared';

export type PresenterGrantId = Id<'PresenterGrant'>;

/**
 * How a presenter grant closed. Terminal, set once:
 *
 *   stopped        the presenter stopped sharing
 *   revoked        another moderator took the slot back (audited)
 *   session_ended  the session ended; `live.session.ended` implies it
 *   ineligible     the presenter may no longer present, or no longer take part
 */
export const PRESENTER_END_REASONS = ['stopped', 'revoked', 'session_ended', 'ineligible'] as const;
export type PresenterEndReason = (typeof PRESENTER_END_REASONS)[number];

/** The reasons a grant closes while its session runs; the end closes it by itself. */
export type PresenterStopReason = Exclude<PresenterEndReason, 'session_ended'>;

/**
 * The screen-share slot (live.md §6): a separate, audited grant, never a
 * speaker right and never a token flag. At most one is open per session (P1),
 * opened only while the session is live, by a moderator holding `live.speak`,
 * for themself (P2; Q56). `grantedBy` is kept apart from `userId` as the seam
 * for a later, delegated path; in v1 they are the same person.
 *
 * Open while `endedAt` is null; a later claim is a new grant.
 */
export interface PresenterGrant {
  readonly id: PresenterGrantId;
  readonly sessionId: string;
  readonly userId: string;
  readonly grantedBy: string;
  readonly grantedAt: Date;
  /** Null exactly while open. */
  readonly endedAt: Date | null;
  /** Who closed it: the presenter, the revoking moderator, or whoever ended the session; null for the system. */
  readonly endedBy: string | null;
  /** Null exactly while open. */
  readonly endReason: PresenterEndReason | null;
}

/** A grant as a claim stores it: open, claimed by the presenter for themself. */
export function newPresenterGrant(input: {
  readonly id: PresenterGrantId;
  readonly sessionId: string;
  readonly userId: string;
  readonly at: Date;
}): PresenterGrant {
  return {
    id: input.id,
    sessionId: input.sessionId,
    userId: input.userId,
    grantedBy: input.userId,
    grantedAt: input.at,
    endedAt: null,
    endedBy: null,
    endReason: null,
  };
}

export function isOpenGrant(grant: PresenterGrant): boolean {
  return grant.endedAt === null;
}

/** The grant, closed. Closing is once: a closed grant is never reopened or closed again. */
export function closePresenterGrant(
  grant: PresenterGrant,
  input: { readonly at: Date; readonly by: string | null; readonly reason: PresenterEndReason },
): PresenterGrant {
  if (!isOpenGrant(grant)) throw new RangeError('a presenter grant closes once');
  return { ...grant, endedAt: input.at, endedBy: input.by, endReason: input.reason };
}

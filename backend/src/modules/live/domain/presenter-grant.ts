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
 * A screen-share grant (live.md §6; Q56, ADR 0028): a separate, audited grant,
 * never a speaker right and never a token flag. At most
 * `MAX_CONCURRENT_PRESENTERS` are open per session, each opened only while the
 * session is live. Two kinds, told apart by `grantedBy`:
 *
 *   by right    an owner/moderator/teacher holding `live.speak` opens one for
 *               themself — `grantedBy === userId`;
 *   delegated   a moderator opens one FOR a student — `grantedBy` the
 *               moderator, `userId` the student. This grant is the student's
 *               only authority to present; it is session-scoped, revocable,
 *               and never a community capability.
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

/**
 * A grant as a claim stores it: open, held by `userId`, opened by `grantedBy`
 * — equal for a by-right self-claim, the moderator for a delegated student.
 */
export function newPresenterGrant(input: {
  readonly id: PresenterGrantId;
  readonly sessionId: string;
  readonly userId: string;
  readonly grantedBy: string;
  readonly at: Date;
}): PresenterGrant {
  return {
    id: input.id,
    sessionId: input.sessionId,
    userId: input.userId,
    grantedBy: input.grantedBy,
    grantedAt: input.at,
    endedAt: null,
    endedBy: null,
    endReason: null,
  };
}

export function isOpenGrant(grant: PresenterGrant): boolean {
  return grant.endedAt === null;
}

/** Delegated: opened by a moderator for someone else (a student). By-right when equal. */
export function isDelegatedGrant(grant: PresenterGrant): boolean {
  return grant.grantedBy !== grant.userId;
}

/** The grant, closed. Closing is once: a closed grant is never reopened or closed again. */
export function closePresenterGrant(
  grant: PresenterGrant,
  input: { readonly at: Date; readonly by: string | null; readonly reason: PresenterEndReason },
): PresenterGrant {
  if (!isOpenGrant(grant)) throw new RangeError('a presenter grant closes once');
  return { ...grant, endedAt: input.at, endedBy: input.by, endReason: input.reason };
}

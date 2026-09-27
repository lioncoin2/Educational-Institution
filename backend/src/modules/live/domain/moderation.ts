import type { Id } from '../../../shared';

export type ModerationActionId = Id<'ModerationAction'>;

/**
 * Every exercise of power over a session or a participant, recorded
 * (live.md §3.5): a start and an end, a grant, decline or revoke of the
 * floor, a presenter grant opened or revoked, the reconciler's automatic
 * media reset (§11.4) — and the seams `mute_participant` and
 * `remove_participant`, which nothing performs yet (Q64).
 */
export const MODERATION_ACTION_TYPES = [
  'start_session',
  'end_session',
  'grant_speaker',
  'decline_speaker',
  'revoke_speaker',
  'grant_presenter',
  'revoke_presenter',
  'reset_media',
  'mute_participant',
  'remove_participant',
] as const;
export type ModerationActionType = (typeof MODERATION_ACTION_TYPES)[number];

/**
 * One moderation record. It is written by the same repository call that
 * makes the change it records — never by a separate log — so the change and
 * its record cannot drift apart; the institution's audit trail gets its own
 * entry through the live journal.
 */
export interface ModerationAction {
  readonly id: ModerationActionId;
  readonly sessionId: string;
  /** Null when the system acted: an idle end, a community closing, a media reset. */
  readonly actorUserId: string | null;
  readonly targetUserId: string | null;
  readonly type: ModerationActionType;
  readonly at: Date;
  /** A code, never free text. */
  readonly reasonCode?: string;
}

/**
 * The institution's audit action for each moderation act — one each, never
 * shared (plan §2.3). A presenter grant's opening is audited as the screen
 * share it starts; its revocation under its own name, since a presenter's
 * own stop is not audited at all.
 */
export const AUDIT_ACTION_BY_MODERATION: Readonly<Record<ModerationActionType, string>> =
  Object.freeze({
    start_session: 'live.session.started',
    end_session: 'live.session.ended',
    grant_speaker: 'live.speaker.granted',
    decline_speaker: 'live.speaker.declined',
    revoke_speaker: 'live.speaker.revoked',
    grant_presenter: 'live.screen_share.started',
    revoke_presenter: 'live.screen_share.revoked',
    reset_media: 'live.session.media_reset',
    mute_participant: 'live.participant.muted',
    remove_participant: 'live.participant.removed',
  });

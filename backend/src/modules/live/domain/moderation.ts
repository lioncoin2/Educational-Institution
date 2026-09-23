import type { Id } from '../../../shared';

export type ModerationActionId = Id<'ModerationAction'>;

/**
 * Every exercise of moderator power over a participant, recorded.
 *
 * Live moderation is explicitly in scope for auditing: who gave or took the
 * floor, and when. The record is written by the same repository call that
 * changes the request, so the change and its record cannot drift apart; the
 * institution's audit trail gets its own entry through the live journal.
 */
export type ModerationActionType =
  | 'grant_speaker'
  | 'decline_speaker'
  | 'revoke_speaker'
  | 'mute_participant'
  | 'remove_participant'
  | 'end_session';

export interface ModerationAction {
  readonly id: ModerationActionId;
  readonly sessionId: string;
  readonly actorUserId: string;
  readonly targetUserId: string | null;
  readonly type: ModerationActionType;
  readonly at: Date;
  /** A code, never free text. */
  readonly reasonCode?: string;
}

/** The institution's audit action for each moderation act — one each, never shared. */
export const AUDIT_ACTION_BY_MODERATION: Readonly<Record<ModerationActionType, string>> = {
  grant_speaker: 'live.speaker.granted',
  decline_speaker: 'live.speaker.declined',
  revoke_speaker: 'live.speaker.revoked',
  mute_participant: 'live.participant.muted',
  remove_participant: 'live.participant.removed',
  end_session: 'live.session.ended',
};

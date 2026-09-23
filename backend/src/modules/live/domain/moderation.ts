import type { Id } from '../../../shared';

export type ModerationActionId = Id<'ModerationAction'>;

/**
 * Every exercise of host power over a participant, recorded.
 *
 * Live moderation is explicitly in scope for auditing: who silenced whom, and
 * when. The record is written by the same use case that performs the action, so
 * the two cannot drift apart.
 */
export type ModerationActionType =
  | 'grant_speaker'
  | 'revoke_speaker'
  | 'decline_speaker'
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
  readonly reason?: string;
}

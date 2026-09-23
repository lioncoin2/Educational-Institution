import type { ConversationType, ParticipantRole } from '../contracts/vocabulary';
import type { ConversationId } from './ids';
import { historyHiddenThrough } from './messaging-policy';

/**
 * A person's membership of one conversation, and their place in it.
 *
 * READ-STATE INVARIANT, per participant:
 *
 *     0 ≤ hiddenThroughSequence ≤ lastReadSequence ≤ conversation.lastSequence
 *
 *   - `hiddenThroughSequence`: messages at or below it predate the member and
 *     are never shown to them (group history, Q21).
 *   - `lastReadSequence`: the read watermark. Everything at or below it counts
 *     as read. It only moves forward, and never past the last message.
 *
 * Membership is CURRENT membership: someone who left (`leftAt` set) reads
 * nothing, and rejoining starts a new visibility window.
 */
export interface Participant {
  readonly conversationId: ConversationId;
  readonly userId: string;
  readonly role: ParticipantRole;
  readonly joinedAt: Date;
  readonly leftAt: Date | null;
  /** Null only where no person added them (reserved for system provisioning). */
  readonly addedBy: string | null;
  readonly lastReadSequence: number;
  readonly hiddenThroughSequence: number;
}

/**
 * Joining NOW: history is hidden per the provisional rule, and everything that
 * exists at this moment counts as read — joining a channel with 500 notices
 * must not greet anyone with "500 unread".
 */
export function newParticipant(
  conversation: {
    readonly id: ConversationId;
    readonly type: ConversationType;
    readonly lastSequence: number;
  },
  userId: string,
  role: ParticipantRole,
  addedBy: string | null,
  at: Date,
): Participant {
  return {
    conversationId: conversation.id,
    userId,
    role,
    joinedAt: at,
    leftAt: null,
    addedBy,
    lastReadSequence: conversation.lastSequence,
    hiddenThroughSequence: historyHiddenThrough(conversation.type, conversation.lastSequence),
  };
}

export function isActive(participant: Participant | null): participant is Participant {
  return participant !== null && participant.leftAt === null;
}

/** In a channel only its owner and publishers write; everyone else reads. */
export function canPost(type: ConversationType, role: ParticipantRole): boolean {
  return type !== 'CHANNEL' || role === 'OWNER' || role === 'PUBLISHER';
}

/** Membership of a direct conversation is fixed; of the others, the owner's to manage. */
export function canManageMembers(type: ConversationType, role: ParticipantRole): boolean {
  return type !== 'DIRECT' && role === 'OWNER';
}

/** Whether this member may see the message with this sequence. */
export function canSee(participant: Participant, sequence: number): boolean {
  return sequence > participant.hiddenThroughSequence;
}

import type { NotificationTarget } from '../contracts/targets';

/**
 * Per-conversation mute — PUSH held for one conversation, and nothing more.
 *
 * A mute is a person's own choice about one conversation's notifications. It
 * removes no membership, revokes no capability, changes no access, disables no
 * category, and touches no other conversation. The record is still stored in
 * the notification center and realtime is untouched — a mute suppresses PUSH
 * for that conversation, exactly as quiet hours suppress push by the clock.
 *
 * The conversation is named by the notification's own typed target
 * (`contracts/targets.ts`): a `conversation` target carries a stable
 * `conversationId`. That is the only kind a mute acts on — a direct message, a
 * group, a channel, or a community's chat are all one conversation kind and
 * mute uniformly. A notification with any other target (a community-membership
 * fact, a live room, a profile) has no conversation to mute, so its behaviour
 * is never changed by a conversation mute.
 */

/** The conversation a notification belongs to, or null when it belongs to none. */
export function conversationIdOf(target: NotificationTarget): string | null {
  return target.kind === 'conversation' ? target.conversationId : null;
}

/**
 * Whether push should be held for this notification because its conversation is
 * muted. False for every notification that is not conversation-scoped — those
 * keep their existing behaviour.
 */
export function isPushMutedFor(
  target: NotificationTarget,
  mutedConversationIds: ReadonlySet<string>,
): boolean {
  const conversationId = conversationIdOf(target);
  return conversationId !== null && mutedConversationIds.has(conversationId);
}

/** One muted conversation, as the owner sees it. */
export interface ConversationMute {
  readonly conversationId: string;
  readonly mutedAt: Date;
}

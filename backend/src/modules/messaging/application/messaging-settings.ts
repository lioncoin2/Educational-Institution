import type { RateLimitPolicy } from '../../../shared';

/** DEVELOPMENT-SAFE DEFAULTS, not a production policy (see authentication.md §8, Q20). */
export const SENDS_PER_USER: RateLimitPolicy = {
  name: 'messaging.send.user',
  limit: 120,
  windowSeconds: 60,
};

export const CONVERSATIONS_CREATED_PER_USER: RateLimitPolicy = {
  name: 'messaging.create.user',
  limit: 60,
  windowSeconds: 60 * 60,
};

/** Page sizes: a default, and a ceiling no request can raise. */
export const PAGE_LIMITS = {
  conversations: { default: 30, max: 100 },
  messages: { default: 50, max: 100 },
  participants: { default: 100, max: 500 },
} as const;

export function pageLimit(requested: number | undefined, limits: { default: number; max: number }) {
  if (requested === undefined || !Number.isInteger(requested) || requested < 1) {
    return limits.default;
  }
  return Math.min(requested, limits.max);
}

/**
 * What messaging records in the audit trail: who changed a conversation's
 * membership, and moderation. Ordinary messages are not audited — the
 * conversation itself is their record.
 */
export const MessagingAudit = {
  conversationCreated: 'messaging.conversation.created',
  participantAdded: 'messaging.participant.added',
  participantRemoved: 'messaging.participant.removed',
  participantLeft: 'messaging.participant.left',
  moderationParticipantRemoved: 'messaging.moderation.participant_removed',
} as const;

export const CONVERSATION_RESOURCE = 'messaging.conversation';

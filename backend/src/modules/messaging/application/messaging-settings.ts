import { failure, type RateLimitPolicy } from '../../../shared';

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
 * conversation itself is their record. A community-chat message deletion and
 * every review of a deleted message's original ARE audited (Q51/Q23): both are
 * moderation, and the review is a disclosure of content.
 */
export const MessagingAudit = {
  conversationCreated: 'messaging.conversation.created',
  participantAdded: 'messaging.participant.added',
  participantRemoved: 'messaging.participant.removed',
  participantLeft: 'messaging.participant.left',
  moderationParticipantRemoved: 'messaging.moderation.participant_removed',
  moderationMessageDeleted: 'messaging.moderation.message_deleted',
  moderationMessageReviewed: 'messaging.moderation.message_reviewed',
} as const;

export const CONVERSATION_RESOURCE = 'messaging.conversation';

/**
 * Community-chat message moderation (Q51/Q23, ADR 0029). The review window and
 * the retention horizon are the SAME 7 days: a deleted message's original is
 * reviewable while `now < deletedAt + reviewWindowMs`, and retention wipes it
 * once `deletedAt + reviewWindowMs <= now` — complementary bounds, so the
 * deterministic 7-day boundary has neither gap nor overlap. DEVELOPMENT-SAFE
 * defaults (not a production retention policy; see Q3, Q23).
 */
export const MESSAGE_MODERATION = {
  /** Exactly 7 days — the owner's fixed review/retention window. */
  reviewWindowMs: 7 * 24 * 60 * 60 * 1000,
  /** How often retention wipes expired content; 0 disables the timer. */
  retentionSweepIntervalMs: 60 * 60 * 1000,
  /** Messages whose content one retention statement wipes. */
  retentionBatch: 500,
} as const;

/** A member of the community without `community.messages.moderate`. */
export const MESSAGE_MODERATION_FORBIDDEN = failure(
  'forbidden',
  'messaging.message_moderation_forbidden',
  'You may not moderate messages in this community.',
);

/** No message with that id in the conversation — asked only after authorization. */
export const MESSAGE_NOT_FOUND = failure(
  'not_found',
  'messaging.message_not_found',
  'No such message in this conversation.',
);

/** No such message to review — absent, or not deleted (review is for deleted messages). */
export const DELETED_MESSAGE_NOT_FOUND = failure(
  'not_found',
  'messaging.deleted_message_not_found',
  'No such deleted message.',
);

/** Deleted, but its 7-day review window has passed; the original is gone. */
export const DELETED_MESSAGE_REVIEW_EXPIRED = failure(
  'not_found',
  'messaging.deleted_message_review_expired',
  'The review window for this deleted message has passed.',
);

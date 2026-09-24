import { failure, type Failure, type RateLimitPolicy } from '../../../shared';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  COMMUNITY CHAT BOUNDS — ENGINEERING, PROVISIONAL (Q26); NOT POLICY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * None of these is a limit on a community's size — that is Communities'
 * concern, and it has none (community-chat.md §10). They bound what messaging
 * does for a community chat until load profile 4 has measured it.
 */

/** DI token. */
export const COMMUNITY_CHAT_SETTINGS = Symbol('COMMUNITY_CHAT_SETTINGS');

export interface CommunityChatSettings {
  /**
   * The capacity switch (§11.2): a community chat whose projected member
   * count is above this refuses new posts (412), and shows `canPost` false,
   * until gates G1–G4 hold for a larger size. Reading, marking read and the
   * projection are unaffected. The default is the largest fan-out any test
   * exercises. A deployment setting; never a membership limit.
   */
  readonly maxServedMembers: number;
  /** How often the sweeper looks for lagging chats; 0 runs the boot sweep only. */
  readonly sweepIntervalMs: number;
}

export const DEFAULT_COMMUNITY_CHAT_SETTINGS: CommunityChatSettings = Object.freeze({
  maxServedMembers: 250,
  sweepIntervalMs: 60_000,
});

/** Community chats synced at once, plus the sweeper: two pool connections at most (§7.5). */
export const SYNC_CONCURRENCY = 1;

/** Opening a community's chat by the community's id — bounds probing (§16). */
export const COMMUNITY_CHATS_OPENED_PER_USER: RateLimitPolicy = {
  name: 'messaging.community_chat.user',
  limit: 60,
  windowSeconds: 60,
};

/** Refusals that exist only for community chats (§13). */
export const MEMBERSHIP_MANAGED_BY_COMMUNITY: Failure = failure(
  'precondition_failed',
  'messaging.membership_managed_by_community',
  "This chat's members are its community's: joining, leaving and removal happen in the community.",
);

export const COMMUNITY_CHAT_OVER_CAPACITY: Failure = failure(
  'precondition_failed',
  'messaging.community_chat_over_capacity',
  'This community chat is larger than posting is available for yet.',
);

export const COMMUNITY_CHAT_POSTING_NOT_ALLOWED: Failure = failure(
  'forbidden',
  'messaging.posting_not_allowed',
  'You may not post in this community chat.',
);

export const COMMUNITY_CHAT_MEMBERS_HIDDEN: Failure = failure(
  'forbidden',
  'messaging.members_hidden',
  "A community chat's members are listed by the community, not here.",
);

/**
 * Communities could not answer. Fail closed: never a role-only answer, and
 * the client learns that retrying is sensible (§15).
 */
export const COMMUNITIES_UNAVAILABLE: Failure = failure(
  'unavailable',
  'unavailable',
  'A service this request needs is briefly unavailable. Try again shortly.',
);

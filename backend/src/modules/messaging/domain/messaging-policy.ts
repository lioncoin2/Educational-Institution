import type { ConversationType } from '../contracts/vocabulary';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  MESSAGING LIMITS AND RULES — PROVISIONAL (open-questions.md Q20–Q23)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Engineering defaults so the system is usable and bounded. None is an
 * institutional decision; each is kept here, in one place, so none is
 * mistaken for one.
 */

/** Characters (code points) in a message body or caption. */
export const MESSAGE_BODY_MAX_LENGTH = 4000;

/** Characters in a group or channel title. */
export const TITLE_MAX_LENGTH = 100;

/** Current members, including the owner. DIRECT is always exactly two. */
export const MAX_PARTICIPANTS: Readonly<Record<ConversationType, number>> = {
  DIRECT: 2,
  GROUP: 500,
  CHANNEL: 10_000,
};

/** People added in one request — bigger audiences are added in batches. */
export const MAX_PARTICIPANTS_PER_REQUEST = 200;

/** Unread counts stop at this; clients show "99+" from here. */
export const UNREAD_COUNT_CAP = 100;

/**
 * Where a new member's view of history starts (Q21).
 *
 * GROUP: at the moment they join. Earlier messages were written to a smaller
 * audience; showing them to newcomers is a disclosure the authors did not
 * choose. CHANNEL: the whole history — a channel is a notice board, and a new
 * student should see the notices. DIRECT: everything; membership is fixed at
 * creation, so there is no "before".
 *
 * Returns the last sequence that stays hidden: 0 hides nothing.
 */
export function historyHiddenThrough(type: ConversationType, lastSequence: number): number {
  return type === 'GROUP' ? lastSequence : 0;
}

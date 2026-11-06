/**
 * Message reactions (Telegram-style): a small, fixed set of emoji a member may
 * put on a message, one per member per message (a second reaction replaces the
 * first; reacting with the same one again removes it — a toggle). The set is
 * curated and closed so a reaction is always a known, renderable glyph and the
 * column can be length-checked; widening it is a one-line change here, visible
 * to its test.
 *
 * Pure domain: no storage, no identity. The use case decides WHO may react
 * (a member who can read the chat); this decides WHAT is a valid reaction.
 */
export const MESSAGE_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

export type MessageReaction = (typeof MESSAGE_REACTIONS)[number];

export function isMessageReaction(value: unknown): value is MessageReaction {
  return typeof value === 'string' && (MESSAGE_REACTIONS as readonly string[]).includes(value);
}

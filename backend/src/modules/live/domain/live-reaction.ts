import { err, failure, ok, type Result } from '../../../shared';

/**
 * The live room's four reactions (C15, ADR 0049) — exactly the four the room's
 * reactions strip has shown since the live redesign (❤️ 👍 👏 😊). A reaction is
 * an ephemeral gesture in a running broadcast: delivered to the session's
 * participants as it happens and kept nowhere — no table, no count, no audit.
 * It is not a chat message and never touches the session's chat or the
 * community's conversation (messaging's message reactions stay excluded).
 */
export const LIVE_REACTION_KINDS = ['heart', 'thumbs_up', 'clap', 'smile'] as const;

export type LiveReactionKind = (typeof LIVE_REACTION_KINDS)[number];

const INVALID = failure(
  'validation',
  'live.reaction_invalid',
  `A reaction is one of ${LIVE_REACTION_KINDS.join(', ')}.`,
);

/** One of the four kinds, or 422 live.reaction_invalid — nothing else travels. */
export function liveReactionKind(raw: unknown): Result<LiveReactionKind> {
  return typeof raw === 'string' && (LIVE_REACTION_KINDS as readonly string[]).includes(raw)
    ? ok(raw as LiveReactionKind)
    : err(INVALID);
}

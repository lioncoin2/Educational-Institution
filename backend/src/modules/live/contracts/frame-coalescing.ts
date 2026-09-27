/**
 * The realtime relay sends a session's moderators at most one
 * `live.session.changed` frame per this interval, carrying the latest state
 * version (Q26): a hand storm costs each moderator four frames a second.
 *
 * A contract, not a domain bound: the relay that applies it lives in
 * realtime, which may read Live's contracts and nothing else. Live's limits
 * re-export this one value (`domain/live-limits.ts`), so it is defined once.
 */
export const MODERATOR_FRAME_COALESCE_MS = 250;

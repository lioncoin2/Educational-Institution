/**
 * `LIVE_PRESENCE` — one principal-less observation of whom the media provider
 * held connected in a live session's room at a single read (attendance.md §5.1,
 * live.md §13). It is **not** stored and says **nothing** about who was
 * "present" (that is policy, Q68); it reports raw connection states only.
 *
 * Sensitive by nature (who is connected), so it is deliberately **not** part of
 * `live/contracts/index.ts`: it is imported directly, and an architecture
 * allow-list test (`live-boundaries.spec`) fails any importer other than
 * attendance and the app wiring. `LIVE_SESSIONS` is the benign scope contract.
 *
 * The caller is a trusted in-process module that has already authorized (as with
 * `MESSAGE_RECIPIENTS`): there is no `Principal` here.
 */
export const LIVE_PRESENCE = Symbol('LIVE_PRESENCE');

/** How the provider held a participant at the read. */
export type ObservedConnection = 'connected' | 'connecting';

/**
 * The answer to one `observe`. Exactly one shape:
 *
 *   observed     a reading was taken; `participants` is one entry per account,
 *                ascending by `userId`, carrying only an account id and a
 *                connection state — no name, LiveKit identity, sid, join time,
 *                source, role or capability
 *   not_found    no such live session
 *   not_active   the session was not live (before or after the read)
 *   unavailable  the provider could not answer in time, errored, or the listing
 *                was oversized — nothing is known, and retrying is safe
 */
export type PresenceObservation =
  | {
      readonly kind: 'observed';
      readonly liveSessionId: string;
      readonly communityId: string;
      readonly observationStartedAt: Date;
      readonly observedAt: Date;
      readonly participants: readonly {
        readonly userId: string;
        readonly connection: ObservedConnection;
      }[];
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_active' }
  | { readonly kind: 'unavailable' };

export interface LivePresence {
  /** Exactly one provider read; never cached. */
  observe(liveSessionId: string): Promise<PresenceObservation>;
}

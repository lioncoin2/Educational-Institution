import { ENFORCEMENT_WATCH_SECONDS } from '../domain/live-limits';
import { baseAccountOf } from '../domain/live-ids';
import type { LiveSession } from '../domain/live-session';
import type { RtcParticipantControl } from '../domain/rtc-provider';
import type { ReconcilerRuntime } from './live-reconciler-runtime';
import type { ReconcilerWatch } from './live-reconciler-watch';

/**
 * Foreign identities (P7.1; audit S2): standard participants whose identity
 * this application never issued (`isIssuedParticipantIdentity`) — a
 * publishing client's `<account id>#<anything>`, say. Each is removed from
 * the room at once, with every token issued before now revoked, and looked
 * for again by the watch for ENFORCEMENT_WATCH_SECONDS, extended on every
 * removal.
 *
 * Decided on the identity alone. A foreign identity is nobody: it never
 * reaches Communities or identity, is never given capabilities, and is
 * never a violation — so never a media reset, which would punish the whole
 * room and could not stop a publisher who may join again. Whoever keeps
 * doing it is visible in the log, a moderation matter (Q64).
 *
 * `live.reconciler.foreign_identity_removed` names the session and — only
 * when the part before `#` is an id — the account whose token was used;
 * never the identity itself, whose rest the client chose.
 */
export class ForeignIdentities {
  constructor(
    private readonly runtime: ReconcilerRuntime,
    private readonly watch: ReconcilerWatch,
    private readonly participants: RtcParticipantControl,
  ) {}

  /**
   * Removes each of `identities` from `room`, the session's current room.
   * How many removals applied; an outage or a fault is thrown after the
   * identity is watched, so the watch still looks for it.
   */
  async remove(
    session: LiveSession,
    room: string,
    identities: readonly string[],
    now: Date,
  ): Promise<number> {
    let removed = 0;
    for (const identity of identities) {
      this.watch.rememberForeign(
        session.id,
        identity,
        new Date(now.getTime() + ENFORCEMENT_WATCH_SECONDS * 1000),
      );
      const outcome = await this.runtime.provider(() =>
        this.participants.removeParticipant(room, identity, { revokeTokensIssuedBefore: now }),
      );
      if (outcome === 'applied') removed += 1;
      const userId = baseAccountOf(identity);
      this.runtime.logger.warn(
        {
          event: 'live.reconciler.foreign_identity_removed',
          sessionId: session.id,
          ...(userId === null ? {} : { userId }),
          outcome,
        },
        'removed a media identity this application never issued',
      );
    }
    return removed;
  }
}

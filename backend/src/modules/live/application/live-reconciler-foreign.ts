import { ENFORCEMENT_WATCH_SECONDS } from '../domain/live-limits';
import { baseAccountOf } from '../domain/live-ids';
import type { LiveSession } from '../domain/live-session';
import {
  RtcMisconfiguredError,
  RtcUnavailableError,
  type RtcApplyOutcome,
  type RtcParticipantControl,
  type RtcParticipantObservation,
} from '../domain/rtc-provider';
import { capabilitiesFor, capabilityDrift } from '../domain/standing';
import type { AccountStanding } from './live-standing';
import type { ReconcilerRuntime } from './live-reconciler-runtime';
import type { ReconcilerWatch } from './live-reconciler-watch';

/** A foreign identity observed in a room, and what its removal came to. */
export interface ForeignSighting {
  /**
   * The account whose token made it — the id before `#` — or null when that
   * part is no id: then it is nobody's, and only removed.
   */
  readonly userId: string | null;
  /** What the provider held for it when it was observed. */
  readonly observed: RtcParticipantObservation;
  /** Whether its removal reported `applied`. */
  readonly applied: boolean;
}

/**
 * What removing a room's foreign identities came to: a sighting of every one
 * observed — whether or not its removal was tried, or worked — and the first
 * failure, if any, for the step to report once the sightings are counted.
 */
export interface ForeignRemoval {
  readonly sightings: readonly ForeignSighting[];
  readonly failure: { readonly error: unknown } | null;
}

/**
 * Foreign identities (P7.1; audit S2): standard participants whose identity
 * this application never issued (`isIssuedParticipantIdentity`) — a
 * publishing client's `<account id>#<anything>`, which LiveKit makes from
 * that account's token when the client asks for `publish` (SRV
 * `pkg/service/utils.go:377-387`). Each is removed from the room at once,
 * with every token issued before now revoked, and looked for again by the
 * watch for ENFORCEMENT_WATCH_SECONDS, extended on every removal.
 *
 * The removal is decided on the identity alone — before, and whatever,
 * Communities or identity say. What it COUNTS for is its account's (P7.2
 * decision R1): the server hands every connection a fresh ten-minute token
 * of its own, so a withdrawn publisher could otherwise chain such identities
 * forever. The participant steps put the account — the id before `#`, never
 * the identity, whose rest the client chose — through `Enforcement`: one
 * that may no longer hold what the identity held has breached, exactly as
 * under its own identity.
 *
 * `live.reconciler.foreign_identity_removed` names the session and — only
 * when the part before `#` is an id — the account whose token was used;
 * never the identity itself.
 */
export class ForeignIdentities {
  constructor(
    private readonly runtime: ReconcilerRuntime,
    private readonly watch: ReconcilerWatch,
    private readonly participants: RtcParticipantControl,
  ) {}

  /**
   * Removes each of `observed` from `room`, the session's current room, and
   * watches it first, so the watch looks for it again whatever happens.
   *
   * Never throws: every identity observed is a sighting, even one whose
   * removal failed or was never tried — what was seen counts for its account
   * all the same (R1), so no failure, and no identity whose removal always
   * fails, can keep an account from being armed. A failure of one identity's
   * removal does not stop the others'; an outage or a refused configuration
   * stops the rest, which would fail alike. The first failure is handed back
   * for the step to report once the sightings are counted.
   */
  async remove(
    session: LiveSession,
    room: string,
    observed: readonly RtcParticipantObservation[],
    now: Date,
  ): Promise<ForeignRemoval> {
    const sightings: ForeignSighting[] = [];
    let failure: { readonly error: unknown } | null = null;
    for (const participant of observed) {
      const identity = participant.identity;
      const userId = baseAccountOf(identity);
      this.watch.rememberForeign(
        session.id,
        identity,
        new Date(now.getTime() + ENFORCEMENT_WATCH_SECONDS * 1000),
      );
      let outcome: RtcApplyOutcome | 'failed' | 'not_tried' = 'not_tried';
      if (failure === null || !providerWide(failure.error)) {
        try {
          outcome = await this.runtime.provider(() =>
            this.participants.removeParticipant(room, identity, { revokeTokensIssuedBefore: now }),
          );
        } catch (error) {
          failure ??= { error };
          outcome = 'failed';
        }
      }
      this.runtime.logger.warn(
        {
          event: 'live.reconciler.foreign_identity_removed',
          sessionId: session.id,
          ...(userId === null ? {} : { userId }),
          outcome,
        },
        outcome === 'failed' || outcome === 'not_tried'
          ? 'could not remove a media identity this application never issued'
          : 'removed a media identity this application never issued',
      );
      sightings.push({ userId, observed: participant, applied: outcome === 'applied' });
    }
    return { sightings, failure };
  }
}

/** A failure every other call to the provider would meet too: an outage, or a refused configuration. */
const providerWide = (error: unknown) =>
  error instanceof RtcUnavailableError || error instanceof RtcMisconfiguredError;

/** An account behind one or more foreign identities seen in one step. */
export interface ForeignAccount {
  readonly userId: string;
  /** What the provider held for each of its foreign identities. */
  readonly observed: readonly RtcParticipantObservation[];
  /** Whether any of their removals reported `applied`. */
  readonly applied: boolean;
}

/**
 * The accounts behind `sightings`, each once, in the order first seen. A
 * sighting whose part before `#` is no id is nobody's, and left out: it was
 * removed, and nothing more is decided about it.
 */
export function foreignAccounts(sightings: readonly ForeignSighting[]): ForeignAccount[] {
  const accounts = new Map<string, ForeignAccount>();
  for (const { userId, observed, applied } of sightings) {
    if (userId === null) continue;
    const seen = accounts.get(userId);
    accounts.set(userId, {
      userId,
      observed: [...(seen?.observed ?? []), observed],
      applied: (seen?.applied ?? false) || applied,
    });
  }
  return [...accounts.values()];
}

/**
 * Whether an account breached through its foreign identities (P7.2 decision
 * R1): Communities no longer lets it stay — it may hold nothing at all — or
 * one of them held, or used, more than the account's standing allows now.
 * An account still entitled to everything its identities held has not: they
 * are removed, and that is all.
 */
export function breachedThrough(account: ForeignAccount, standing: AccountStanding): boolean {
  if (!standing.eligible) return true;
  const allowed = capabilitiesFor(standing.standing);
  return account.observed.some((observed) => capabilityDrift(observed, allowed) === 'exceeds');
}

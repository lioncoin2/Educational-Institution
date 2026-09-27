/**
 * What the reconciler's ticks and per-session checks report (live.md §11):
 * counts only. Ids, epochs and codes go to its log lines — never a token or
 * a name.
 */

/**
 * Why a whole tick did nothing: another run of the same tick was still going
 * (ticks never queue), the media provider could not be reached, its answers
 * are positively not LiveKit's (its self-check reports
 * `incompatible_response` — a wrong endpoint), or an input every step
 * depends on — the live sessions, the room list — could not be read
 * completely.
 */
export type TickSkip = 'in_flight' | 'provider_unavailable' | 'provider_incompatible' | 'failed';

/** What the per-identity steps of one or more sessions did. */
export interface IdentityTally {
  /** Identities that went through the per-identity step. */
  readonly checked: number;
  /** Removed from the room: not eligible to stay. */
  readonly removed: number;
  /** Held more than their set: the full set pushed, and watched. */
  readonly corrected: number;
  /** Held less than their set — a grant not yet applied: pushed, never a violation. */
  readonly pushed: number;
  /** Breaches seen again after a correction that reported `applied` (audit D22). */
  readonly violations: number;
  /** Media resets that moved a session to a new room (§11.4). */
  readonly resets: number;
}

/** The room sweep's report (design §11.2). */
export interface RoomSweepReport {
  readonly skipped: TickSkip | null;
  /** Live sessions paged. */
  readonly sessions: number;
  /** Of them, skipped on unknown state or a fault: nothing was done to them. */
  readonly sessionsSkipped: number;
  /** Missing current rooms ensured and kept (re-checked live on the same epoch). */
  readonly ensured: number;
  /** Sessions ended `idle`. */
  readonly idleEnded: number;
  /** Rooms of this deployment's form that no live session claims, ended after their grace. */
  readonly orphansEnded: number;
}

/** The participant sweep's and the targeted watch's report (design §11.3, §11.4). */
export interface SessionSweepReport extends IdentityTally {
  readonly skipped: TickSkip | null;
  /** Live sessions paged. */
  readonly sessions: number;
  /** Of them, skipped on unknown state or a fault: nobody in them was touched. */
  readonly sessionsSkipped: number;
  /** Sessions ended `community_closed`. */
  readonly ended: number;
  /**
   * Removals of a foreign identity that applied (P7.1): participants this
   * application never issued. Nobody's — so never in the tally of people
   * above: never checked, never a violation, never a reset.
   */
  readonly foreignRemoved: number;
}

/** One session's check — the sweep's, the watch's, or `ProtectLiveSessions`'. */
export interface SessionCheckReport extends IdentityTally {
  /**
   *   checked               every input was read, and every step ran
   *   not_live              the session is unknown or no longer live: nothing to do
   *   community_closed      Communities no longer lets it run: ended, nothing else
   *   skipped               an input could not be read, or a fault: nothing decided
   *   provider_unavailable  the media provider could not be reached: nothing decided
   */
  readonly outcome:
    'checked' | 'not_live' | 'community_closed' | 'skipped' | 'provider_unavailable';
}

/**
 * What one session's step did: its check's report, and the foreign
 * identities it removed — counted by the tick that ran it (`foreignRemoved`),
 * and by no check's report, whose tally is of people.
 */
export interface SessionStep {
  readonly report: SessionCheckReport;
  readonly foreignRemoved: number;
}

export const NO_TALLY: IdentityTally = Object.freeze({
  checked: 0,
  removed: 0,
  corrected: 0,
  pushed: 0,
  violations: 0,
  resets: 0,
});

export function emptyRooms(skipped: TickSkip): RoomSweepReport {
  return { skipped, sessions: 0, sessionsSkipped: 0, ensured: 0, idleEnded: 0, orphansEnded: 0 };
}

export function emptySweep(skipped: TickSkip): SessionSweepReport {
  return { ...NO_TALLY, skipped, sessions: 0, sessionsSkipped: 0, ended: 0, foreignRemoved: 0 };
}

/** A step that touched nobody, with this outcome. */
export function noStep(outcome: SessionCheckReport['outcome']): SessionStep {
  return { report: { ...NO_TALLY, outcome }, foreignRemoved: 0 };
}

export function addTally(a: IdentityTally, b: IdentityTally): IdentityTally {
  return {
    checked: a.checked + b.checked,
    removed: a.removed + b.removed,
    corrected: a.corrected + b.corrected,
    pushed: a.pushed + b.pushed,
    violations: a.violations + b.violations,
    resets: a.resets + b.resets,
  };
}

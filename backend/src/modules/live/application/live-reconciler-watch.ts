/**
 * How many (session, identity) enforcement entries are kept; the oldest go
 * first. The foreign identities under watch are bounded by the same number,
 * apart: however many a client makes, they never push out an enforcement
 * entry.
 */
export const WATCH_ENTRY_LIMIT = 10_000;

/** One identity under enforcement (design §11.4; audit D10, D22). */
export interface WatchEntry {
  readonly sessionId: string;
  readonly userId: string;
  /** Watched until then; extended on every correction and violation. */
  readonly until: Date;
  /** Whether the last correction REPORTED `applied` — only then is a repeat a violation. */
  readonly applied: boolean;
}

/** A foreign identity removed from a session's room, looked for again until `until`. */
interface ForeignEntry {
  readonly sessionId: string;
  readonly identity: string;
  readonly until: Date;
}

/**
 * An account one of whose foreign identities was seen holding more than the
 * account may hold (P7.2 decision R1): a sighting of another before `until`
 * is a reappearance.
 */
interface ForeignBreachEntry {
  readonly sessionId: string;
  readonly userId: string;
  readonly until: Date;
}

/**
 * The targeted watch's memory in this process (design §11.4; audit D10,
 * D22): who a correction or a removal put under enforcement, in which
 * session, until when, and whether that correction reported `applied`.
 * Postgres holds the rest of the watch — the floors and presenter grants
 * closed inside the window — so a restart loses only this part, and the
 * participant sweep backstops it.
 *
 * Beside them, apart, the foreign identities removed (P7.1): never people,
 * so never armed themselves — only looked for again, for the same window —
 * and the accounts whose foreign identities breached (P7.2 decision R1),
 * armed by that sighting alone: the next breaching sighting of the same
 * account, under any suffix, is a violation. The two arms never mix. A
 * correction of the account's own identity arms only that identity, and a
 * foreign sighting only the account's foreign identities — so which step
 * happens to observe which identity first never decides a reset.
 *
 * Each is bounded to WATCH_ENTRY_LIMIT entries, the oldest dropped first.
 */
export class ReconcilerWatch {
  private readonly entries = new Map<string, WatchEntry>();
  private readonly foreign = new Map<string, ForeignEntry>();
  private readonly foreignBreaches = new Map<string, ForeignBreachEntry>();

  /** Under the watch of a correction that reported `applied`: a breach now may be a violation. */
  armed(sessionId: string, userId: string, now: Date): boolean {
    const entry = this.entries.get(watchKey(sessionId, userId));
    return entry !== undefined && entry.until.getTime() > now.getTime() && entry.applied;
  }

  remember(entry: WatchEntry): void {
    // The oldest go first. Losing one is the safe direction: the next breach
    // of that identity is a correction, never a violation.
    keepNewest(this.entries, watchKey(entry.sessionId, entry.userId), entry);
  }

  /**
   * Who is under enforcement in a session now — by a correction of their own
   * identity, or a breach through a foreign one — each once, oldest entry
   * first. An entry whose window has passed is dropped on the way.
   */
  watchedIn(sessionId: string, now: Date): string[] {
    return [
      ...new Set([
        ...current(this.entries, sessionId, now).map((entry) => entry.userId),
        ...current(this.foreignBreaches, sessionId, now).map((entry) => entry.userId),
      ]),
    ];
  }

  /**
   * Whether anything at all is watched in a session now: someone under
   * enforcement, or a foreign identity to look for again. Only then can a
   * step find a violation, or an identity it cannot look up by name.
   */
  anyIn(sessionId: string, now: Date): boolean {
    return (
      current(this.entries, sessionId, now).length > 0 ||
      current(this.foreign, sessionId, now).length > 0 ||
      current(this.foreignBreaches, sessionId, now).length > 0
    );
  }

  /**
   * Whether one of the account's foreign identities was seen breaching
   * inside the window (P7.2 decision R1): a breaching sighting now is its
   * reappearance.
   */
  foreignArmed(sessionId: string, userId: string, now: Date): boolean {
    const entry = this.foreignBreaches.get(watchKey(sessionId, userId));
    return entry !== undefined && entry.until.getTime() > now.getTime();
  }

  /** A breaching sighting of the account's foreign identities: watched until `until`. */
  armForeign(sessionId: string, userId: string, until: Date): void {
    keepNewest(this.foreignBreaches, watchKey(sessionId, userId), { sessionId, userId, until });
  }

  /**
   * A foreign identity removed from a session's room, to be looked for again
   * until `until`. Losing one to the bound costs a period at most: the
   * participant sweep lists everyone in the room.
   */
  rememberForeign(sessionId: string, identity: string, until: Date): void {
    keepNewest(this.foreign, watchKey(sessionId, identity), { sessionId, identity, until });
  }

  /** The foreign identities a session's watch looks for now, oldest first; past ones are dropped. */
  foreignIn(sessionId: string, now: Date): string[] {
    return current(this.foreign, sessionId, now).map((entry) => entry.identity);
  }

  /** Drops everything watched in a session that ended. */
  forget(sessionId: string): void {
    for (const watched of [this.entries, this.foreign, this.foreignBreaches]) {
      for (const [key, entry] of watched) {
        if (entry.sessionId === sessionId) watched.delete(key);
      }
    }
  }

  /** Drops everything watched in every session that is not among `liveIds`. */
  keepOnly(liveIds: ReadonlySet<string>): void {
    for (const watched of [this.entries, this.foreign, this.foreignBreaches]) {
      for (const [key, entry] of watched) {
        if (!liveIds.has(entry.sessionId)) watched.delete(key);
      }
    }
  }
}

const watchKey = (sessionId: string, identity: string) => `${sessionId}\u0000${identity}`;

/** Sets `key` as the newest entry, then drops the oldest beyond WATCH_ENTRY_LIMIT. */
function keepNewest<E>(watched: Map<string, E>, key: string, entry: E): void {
  watched.delete(key);
  watched.set(key, entry);
  for (const oldest of watched.keys()) {
    if (watched.size <= WATCH_ENTRY_LIMIT) break;
    watched.delete(oldest);
  }
}

/** A session's entries still inside their window, oldest first; the rest of its entries are dropped. */
function current<E extends { readonly sessionId: string; readonly until: Date }>(
  watched: Map<string, E>,
  sessionId: string,
  now: Date,
): E[] {
  const inside: E[] = [];
  for (const [key, entry] of watched) {
    if (entry.sessionId !== sessionId) continue;
    if (entry.until.getTime() > now.getTime()) inside.push(entry);
    else watched.delete(key);
  }
  return inside;
}

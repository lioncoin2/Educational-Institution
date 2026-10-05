import { err, failure, ok, type Id, type Result } from '../../../shared';
import type { SnapshotConnection } from '../contracts/vocabulary';

/** A participant the provider held at the press: a stable account id and how it was connected. */
export interface SnapshotEntry {
  readonly userId: string;
  readonly connection: SnapshotConnection;
}

/** The only observation rule today (attendance.md §5.2); a different rule would take a new id. */
export type ObservationRule = 'provider_registry_v1';

/** The current rule the domain stamps on every snapshot it builds. */
export const OBSERVATION_RULE: ObservationRule = 'provider_registry_v1';

/**
 * One server-taken observation of whom Live held connected at a press
 * (attendance.md §6.1). It has no lifecycle: created once, read afterwards.
 * Ids only — no display names, LiveKit identities or sids, join times or roles
 * (§6.2 I7); names are resolved at view time (§6.3).
 */
export interface AttendanceSnapshot {
  readonly id: Id<'AttendanceSnapshot'>;
  /** The community the recording permit was issued for. */
  readonly communityId: string;
  /** Live's LiveSession id — never a LiveKit room name, sid or identity. */
  readonly liveSessionId: string;
  /** Live's hostUserId at the press: the host's view basis (§11.3). */
  readonly hostUserId: string;
  /** The recorder's account id — `principal.userId`, never from the client. */
  readonly recordedBy: string;
  /** The idempotency key: `^[A-Za-z0-9_-]{8,64}$`. */
  readonly clientRequestId: string;
  readonly observationRule: ObservationRule;
  readonly observationStartedAt: Date;
  readonly observedAt: Date;
  /** `max(now, observedAt)`, so `observedAt ≤ recordedAt` always holds (§6.2 I3). */
  readonly recordedAt: Date;
  readonly connectedCount: number;
  readonly connectingCount: number;
  readonly entries: readonly SnapshotEntry[];
}

/**
 * A snapshot's header — every field except the entries (attendance.md §7). It
 * is the read shape: an idempotency replay (§8), a single-snapshot view and the
 * community list all read the header, while the entries are paged apart (§15.1).
 */
export type AttendanceSnapshotHeader = Omit<AttendanceSnapshot, 'entries'>;

/**
 * What `takeSnapshot` turns into a snapshot. The application maps Live's
 * `PresenceObservation` into this, so the domain never imports Live (§6.1). The
 * clock reading at the press (`now`) is supplied by the use case, keeping the
 * domain pure; `recordedAt` is derived as `max(now, observedAt)`.
 */
export interface TakeSnapshotInput {
  readonly id: Id<'AttendanceSnapshot'>;
  readonly communityId: string;
  readonly liveSessionId: string;
  readonly hostUserId: string;
  readonly recordedBy: string;
  readonly clientRequestId: string;
  readonly observationStartedAt: Date;
  readonly observedAt: Date;
  readonly now: Date;
  /** As observed; re-validated here to one entry per account, CONNECTED winning (§6.2 I1). */
  readonly entries: readonly SnapshotEntry[];
}

const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/u;

export const CLIENT_REQUEST_ID_INVALID = failure(
  'validation',
  'attendance.client_request_id_invalid',
  'The client request id must match ^[A-Za-z0-9_-]{8,64}$.',
);

/**
 * Whether a `clientRequestId` matches `^[A-Za-z0-9_-]{8,64}$` — the one regex,
 * the one source of truth. The record use case checks this first (attendance.md
 * §18 S1 step 2, before any lookup, authorization, charge or observation), and
 * `takeSnapshot` re-checks it as a domain invariant.
 */
export function isValidClientRequestId(value: string): boolean {
  return CLIENT_REQUEST_ID.test(value);
}

/**
 * Build a snapshot from an observation (attendance.md §6.1). **Pure**: no clock,
 * no store, no side effect, no framework. It
 *
 *   - refuses a malformed `clientRequestId` with `attendance.client_request_id_invalid`;
 *   - re-validates what Live already guarantees — one entry per account, with
 *     CONNECTED winning over CONNECTING (§6.2 I1);
 *   - derives the two counts from those entries (§6.2 I2);
 *   - stamps `recordedAt = max(now, observedAt)`, so `observedAt ≤ recordedAt` (§6.2 I3);
 *   - stamps the current observation rule.
 *
 * Zero entries is a valid snapshot. The result is frozen: a snapshot is
 * immutable, and nothing here (or anywhere) mutates one (§6.2 I5).
 */
export function takeSnapshot(input: TakeSnapshotInput): Result<AttendanceSnapshot> {
  if (!isValidClientRequestId(input.clientRequestId)) return err(CLIENT_REQUEST_ID_INVALID);

  const entries = collapse(input.entries);
  const connectedCount = entries.filter((entry) => entry.connection === 'CONNECTED').length;
  const connectingCount = entries.length - connectedCount;
  const recordedAt =
    input.now.getTime() >= input.observedAt.getTime() ? input.now : input.observedAt;

  return ok(
    Object.freeze({
      id: input.id,
      communityId: input.communityId,
      liveSessionId: input.liveSessionId,
      hostUserId: input.hostUserId,
      recordedBy: input.recordedBy,
      clientRequestId: input.clientRequestId,
      observationRule: OBSERVATION_RULE,
      observationStartedAt: input.observationStartedAt,
      observedAt: input.observedAt,
      recordedAt,
      connectedCount,
      connectingCount,
      entries,
    }),
  );
}

/**
 * One entry per account, CONNECTED winning over CONNECTING (§6.2 I1), ordered
 * ascending by account id for a determinate result (the observation is already
 * ascending, §5.1). Live guarantees this; the domain re-establishes it so a
 * snapshot is sound whatever produced its input.
 */
function collapse(entries: readonly SnapshotEntry[]): readonly SnapshotEntry[] {
  const byUser = new Map<string, SnapshotConnection>();
  for (const entry of entries) {
    const current = byUser.get(entry.userId);
    if (current === undefined || entry.connection === 'CONNECTED') {
      byUser.set(entry.userId, entry.connection);
    }
  }
  const collapsed = [...byUser.entries()]
    .map(([userId, connection]) => Object.freeze({ userId, connection }))
    .sort((a, b) => compareIds(a.userId, b.userId));
  return Object.freeze(collapsed);
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

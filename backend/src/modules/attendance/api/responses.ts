import type { AccountDirectory } from '../../identity/contracts';
import type { RecordSnapshotResult } from '../application/record-attendance-snapshot.use-case';

/**
 * The stored header the record use case returns — sourced through the
 * application layer, never the domain: a controller speaks application results,
 * not domain entities (the `api-does-not-touch-domain-internals` boundary).
 */
type SnapshotHeader = RecordSnapshotResult['snapshot'];

/**
 * The wire shape of a recorded snapshot (attendance.md §15.1/§15.3): the
 * header — never the participant entries, which are paged apart (§7, §15.1) —
 * with the recorder's name resolved at view time (§6.3). Instants are ISO-8601.
 * The same shape answers a 201 (created) and a 200 (idempotency replay).
 */
export interface SnapshotView {
  readonly id: string;
  readonly communityId: string;
  readonly liveSessionId: string;
  /** The recorder; the name is resolved from the directory, null if unknown. */
  readonly recordedBy: {
    readonly userId: string;
    readonly displayName: string | null;
  };
  readonly observationRule: SnapshotHeader['observationRule'];
  readonly observationStartedAt: string;
  readonly observedAt: string;
  readonly recordedAt: string;
  readonly connectedCount: number;
  readonly connectingCount: number;
}

/**
 * Format a snapshot header for the wire, resolving the recorder's display name
 * through the account directory (§6.3) — one call per snapshot. The recorder
 * just authenticated, so the directory knows them; an id it cannot resolve
 * leaves the name null rather than failing the response. No participant data is
 * read or returned here.
 */
export async function toSnapshotView(
  header: SnapshotHeader,
  directory: AccountDirectory,
): Promise<SnapshotView> {
  const summaries = await directory.describe([header.recordedBy]);
  const summary = summaries.find((account) => account.userId === header.recordedBy);
  return {
    id: header.id,
    communityId: header.communityId,
    liveSessionId: header.liveSessionId,
    recordedBy: {
      userId: header.recordedBy,
      displayName: summary?.displayName ?? null,
    },
    observationRule: header.observationRule,
    observationStartedAt: header.observationStartedAt.toISOString(),
    observedAt: header.observedAt.toISOString(),
    recordedAt: header.recordedAt.toISOString(),
    connectedCount: header.connectedCount,
    connectingCount: header.connectingCount,
  };
}

import type { AccountDirectory } from '../../identity/contracts';
import type { RecordSnapshotResult } from '../application/record-attendance-snapshot.use-case';
import type { SnapshotConnection } from '../contracts/vocabulary';

/**
 * The stored header the use cases return — sourced through the application
 * layer, never the domain: a controller speaks application results, not domain
 * entities (the `api-does-not-touch-domain-internals` boundary).
 */
type SnapshotHeader = RecordSnapshotResult['snapshot'];

/** One entry as the application returns it — the same structural shape, no domain import. */
interface SnapshotEntryShape {
  readonly userId: string;
  readonly connection: SnapshotConnection;
}

/** A keyset page as the repository/use case returns it (`nextCursor` omitted when absent). */
interface PageShape<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/** The wire envelope every attendance list route returns: `nextCursor` is always present, null on the last page. */
interface PageResponse<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/**
 * The wire shape of a recorded snapshot (attendance.md §15.1/§15.3): the
 * header — never the participant entries, which are paged apart (§7, §15.1) —
 * with the recorder's name resolved at view time (§6.3). Instants are ISO-8601.
 * The same shape answers the POST (201/200) and the single-snapshot GET.
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

/** One participant on the entries page (§15.3): an account id, its name (null if unknown) and how it was held. No email, ever; no "present". */
export interface SnapshotParticipant {
  readonly userId: string;
  readonly displayName: string | null;
  readonly connection: SnapshotConnection;
}

/** The pure header→wire mapping; the display name is resolved by the caller. */
function snapshotViewOf(header: SnapshotHeader, displayName: string | null): SnapshotView {
  return {
    id: header.id,
    communityId: header.communityId,
    liveSessionId: header.liveSessionId,
    recordedBy: { userId: header.recordedBy, displayName },
    observationRule: header.observationRule,
    observationStartedAt: header.observationStartedAt.toISOString(),
    observedAt: header.observedAt.toISOString(),
    recordedAt: header.recordedAt.toISOString(),
    connectedCount: header.connectedCount,
    connectingCount: header.connectingCount,
  };
}

/**
 * Resolve display names for a page's account ids in **one** directory call
 * (§6.3) — skipped for an empty page. Unknown and deactivated ids simply don't
 * appear here, so the caller defaults them to null; a deactivated account the
 * directory still knows keeps its name (it is historical).
 */
async function namesOf(
  ids: readonly string[],
  directory: AccountDirectory,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const summaries = await directory.describe(ids);
  return new Map(summaries.map((account) => [account.userId, account.displayName]));
}

/**
 * Format a snapshot header for the wire, resolving the recorder's display name
 * through the account directory (§6.3). An id it cannot resolve leaves the name
 * null rather than failing the response. No participant data is read or returned.
 */
export async function toSnapshotView(
  header: SnapshotHeader,
  directory: AccountDirectory,
): Promise<SnapshotView> {
  const names = await namesOf([header.recordedBy], directory);
  return snapshotViewOf(header, names.get(header.recordedBy) ?? null);
}

/**
 * A page of snapshot headers for the wire (§15.1): newest first, every
 * recorder's name resolved in one directory call, `nextCursor` normalized to
 * `string | null`.
 */
export async function toSnapshotPageResponse(
  page: PageShape<SnapshotHeader>,
  directory: AccountDirectory,
): Promise<PageResponse<SnapshotView>> {
  const names = await namesOf(
    [...new Set(page.items.map((header) => header.recordedBy))],
    directory,
  );
  return {
    items: page.items.map((header) => snapshotViewOf(header, names.get(header.recordedBy) ?? null)),
    nextCursor: page.nextCursor ?? null,
  };
}

/**
 * A page of participants for the wire (§15.1/§15.3): account ids in keyset
 * order, each name resolved in one directory call (null if unknown), the
 * connection as held. Never an email, never a "present" field.
 */
export async function toParticipantsPageResponse(
  page: PageShape<SnapshotEntryShape>,
  directory: AccountDirectory,
): Promise<PageResponse<SnapshotParticipant>> {
  const names = await namesOf([...new Set(page.items.map((entry) => entry.userId))], directory);
  return {
    items: page.items.map((entry) => ({
      userId: entry.userId,
      displayName: names.get(entry.userId) ?? null,
      connection: entry.connection,
    })),
    nextCursor: page.nextCursor ?? null,
  };
}

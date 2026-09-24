/**
 * The page size `onlineAudience` asks for and the most ids it names at once.
 * Equal to both sources' own bound — messaging's MAX_RECIPIENT_PAGE and
 * Communities' MAX_MEMBER_PAGE, pinned together by a test — so one page is
 * one call on either side, never a call a source refuses.
 */
export const AUDIENCE_PAGE = 1000;

/** One page of an audience, as its source answers it: ids and where to continue. */
export interface AudiencePage {
  readonly userIds: readonly string[];
  readonly nextCursor: string | null;
}

/**
 * A source's audience, a page at a time — messaging's MESSAGE_RECIPIENTS or
 * Communities' COMMUNITY_MEMBERSHIP.members, each with its own filters bound
 * in. `onlyUserIds` narrows a page to those people, if they belong.
 */
export type AudiencePager = (page: {
  readonly onlyUserIds?: readonly string[];
  readonly cursor: string | null;
  readonly limit: number;
}) => Promise<AudiencePage>;

/**
 * Who of an audience is connected here: `pageOf`'s members ∩ `online`,
 * each once (ADR 0021 decision 7; communities-live-attendance.md §7.6).
 *
 * What it costs is bounded by the connections, not by the audience:
 *
 *   nobody online               no call at all
 *   the audience fits a page    one call — its members, kept if online
 *   anything larger             that first call, then the online accounts
 *                               named in chunks of AUDIENCE_PAGE — at most
 *                               1 + ⌈A/1000⌉ calls for A accounts online,
 *                               whether the audience is 2,000 or 100,000
 *
 * Walking every page instead costs ⌈N/1000⌉ calls for N members, per event,
 * whoever is connected: 30 at 30,000 members to reach the handful online.
 *
 * The source stays the only judge of who belongs: every id returned came
 * from it, asked at delivery time — nothing here is cached or widened.
 */
export async function onlineAudience(
  online: readonly string[],
  pageOf: AudiencePager,
): Promise<string[]> {
  const connected = new Set(online);
  if (connected.size === 0) return [];

  const first = await pageOf({ cursor: null, limit: AUDIENCE_PAGE });
  if (first.nextCursor === null) {
    return [...new Set(first.userIds.filter((userId) => connected.has(userId)))];
  }

  const audience = new Set<string>();
  const accounts = [...connected];
  for (let from = 0; from < accounts.length; from += AUDIENCE_PAGE) {
    const chunk = accounts.slice(from, from + AUDIENCE_PAGE);
    // A chunk of at most one page of names fits one page of answers; the
    // cursor is still followed, so a source that pages shorter loses no one.
    let cursor: string | null = null;
    do {
      const page = await pageOf({ onlyUserIds: chunk, cursor, limit: AUDIENCE_PAGE });
      for (const userId of page.userIds) if (connected.has(userId)) audience.add(userId);
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
  return [...audience];
}

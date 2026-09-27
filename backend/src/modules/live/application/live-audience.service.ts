import { Inject, Injectable } from '@nestjs/common';

import {
  COMMUNITY_AUTHORIZATION,
  type CommunityAuthorization,
} from '../../communities/contracts/authorization';
import {
  COMMUNITY_CAPABILITY_HOLDERS,
  type CommunityCapabilityHolders,
} from '../../communities/contracts/capability-holders';
import { MAX_AUDIENCE_PROBE, type LiveAudience } from '../contracts/live-audience';
import { isLive, type LiveSession } from '../domain/live-session';
import { LIVE_SESSION_REPOSITORY, type LiveSessionRepository } from '../domain/ports';

/**
 * Where a `moderators` walk is:
 *
 *   holders  paging COMMUNITY_CAPABILITY_HOLDERS from its cursor (null: from
 *            the start); `hostSeen` — the host was already listed among them
 *   host     every holder listed; only the host is left to answer for
 */
type ModeratorPosition =
  | {
      readonly phase: 'holders';
      readonly sessionId: string;
      /** Communities' cursor; null only before the first page. */
      readonly holders: string | null;
      readonly hostSeen: boolean;
    }
  | { readonly phase: 'host'; readonly sessionId: string };

const CURSOR_VERSION = 'la1';

/** An inner cursor longer than this was not one Communities issued. */
const MAX_INNER_CURSOR = 512;

/** Never echoes what it was given: a cursor may be anything a caller passed on. */
const FOREIGN_CURSOR = 'That cursor was not issued by LIVE_AUDIENCE for this session.';

/**
 * LIVE_AUDIENCE (live.md §13) — who a session's facts may reach, for
 * realtime's relay. Every answer is Communities', asked now: Live keeps no
 * membership, ceiling or lifecycle rule of its own, and caches nothing. A
 * Communities failure rejects the whole call — never a partial answer.
 */
@Injectable()
export class LiveAudienceService implements LiveAudience {
  constructor(
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(COMMUNITY_AUTHORIZATION) private readonly communities: CommunityAuthorization,
    @Inject(COMMUNITY_CAPABILITY_HOLDERS) private readonly holders: CommunityCapabilityHolders,
  ) {}

  /**
   * One `permittedAmong` per act, at most: `community.live.join` for all of
   * them; `community.live.moderate` for the rest (a moderator may take part
   * without a join permit); `community.live.host` for the host alone, when
   * they are among the rest and not already a moderator. The session's state
   * is ignored — the caller asks about a session it is relaying.
   */
  async participantsAmong(
    sessionId: string,
    userIds: readonly string[],
  ): Promise<readonly string[]> {
    if (userIds.length > MAX_AUDIENCE_PROBE) {
      throw new RangeError(`participantsAmong takes at most ${MAX_AUDIENCE_PROBE} user ids.`);
    }
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return [];
    const session = await this.sessions.findById(sessionId);
    if (session === null) return [];
    const { communityId, hostUserId } = session;

    const admitted = new Set(
      await this.communities.permittedAmong(communityId, ids, 'community.live.join'),
    );
    const rest = ids.filter((userId) => !admitted.has(userId));
    if (rest.length > 0) {
      for (const userId of await this.communities.permittedAmong(
        communityId,
        rest,
        'community.live.moderate',
      )) {
        admitted.add(userId);
      }
      if (rest.includes(hostUserId) && !admitted.has(hostUserId)) {
        const host = await this.communities.permittedAmong(
          communityId,
          [hostUserId],
          'community.live.host',
        );
        if (host.includes(hostUserId)) admitted.add(hostUserId);
      }
    }
    return ids.filter((userId) => admitted.has(userId));
  }

  /**
   * The holders of `community.live.moderate`, a Communities page at a time in
   * its (user-id) order, then the host — unless they were already listed
   * among the holders — while `community.live.host` holds for them. The
   * cursor carries which of the two is being walked, and whether the host
   * was seen, so every id comes exactly once and no page exceeds `limit`.
   * The session is read on every page: once it has ended, the walk answers
   * nothing more.
   */
  async moderators(
    sessionId: string,
    page: { readonly cursor?: string | null; readonly limit: number },
  ): Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }> {
    const { limit } = page;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIENCE_PROBE) {
      throw new RangeError(`A page is 1 to ${MAX_AUDIENCE_PROBE} moderators.`);
    }
    const position: ModeratorPosition =
      page.cursor === undefined || page.cursor === null
        ? { phase: 'holders', sessionId, holders: null, hostSeen: false }
        : decodePosition(page.cursor, sessionId);

    const session = await this.sessions.findById(sessionId);
    if (session === null || !isLive(session)) return { userIds: [], nextCursor: null };

    if (position.phase === 'host') {
      return {
        userIds: (await this.hostModerates(session)) ? [session.hostUserId] : [],
        nextCursor: null,
      };
    }

    let listed: Awaited<ReturnType<CommunityCapabilityHolders['list']>>;
    try {
      listed = await this.holders.list(session.communityId, 'community.live.moderate', {
        cursor: position.holders,
        limit,
      });
    } catch (error) {
      // The limit was checked above, so a RangeError here is the inner cursor:
      // not one Communities issued, whatever this contract's wrapping said.
      if (error instanceof RangeError) throw new RangeError(FOREIGN_CURSOR);
      throw error;
    }
    const hostSeen = position.hostSeen || listed.userIds.includes(session.hostUserId);
    if (listed.nextCursor !== null) {
      return {
        userIds: listed.userIds,
        nextCursor: encodePosition({
          phase: 'holders',
          sessionId,
          holders: listed.nextCursor,
          hostSeen,
        }),
      };
    }
    // Every holder listed: the host is the last to answer for, once.
    if (hostSeen) return { userIds: listed.userIds, nextCursor: null };
    if (listed.userIds.length < limit) {
      return {
        userIds: (await this.hostModerates(session))
          ? [...listed.userIds, session.hostUserId]
          : listed.userIds,
        nextCursor: null,
      };
    }
    return { userIds: listed.userIds, nextCursor: encodePosition({ phase: 'host', sessionId }) };
  }

  /** Whether Communities still lets the starter host this session (Q54). */
  private async hostModerates(session: LiveSession): Promise<boolean> {
    const host = await this.communities.permittedAmong(
      session.communityId,
      [session.hostUserId],
      'community.live.host',
    );
    return host.includes(session.hostUserId);
  }
}

function encodePosition(position: ModeratorPosition): string {
  const fields =
    position.phase === 'host'
      ? [CURSOR_VERSION, position.sessionId, 'host']
      : [CURSOR_VERSION, position.sessionId, 'holders', position.holders, position.hostSeen];
  return Buffer.from(JSON.stringify(fields)).toString('base64url');
}

/** A cursor this contract issued for this session, or a RangeError that never repeats it. */
function decodePosition(raw: string, sessionId: string): ModeratorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new RangeError(FOREIGN_CURSOR);
  }
  if (!Array.isArray(parsed) || parsed[0] !== CURSOR_VERSION || parsed[1] !== sessionId) {
    throw new RangeError(FOREIGN_CURSOR);
  }
  if (parsed.length === 3 && parsed[2] === 'host') return { phase: 'host', sessionId };
  const [, , phase, holders, hostSeen] = parsed as unknown[];
  if (
    parsed.length === 5 &&
    phase === 'holders' &&
    typeof holders === 'string' &&
    holders.length > 0 &&
    holders.length <= MAX_INNER_CURSOR &&
    typeof hostSeen === 'boolean'
  ) {
    return { phase: 'holders', sessionId, holders, hostSeen };
  }
  throw new RangeError(FOREIGN_CURSOR);
}

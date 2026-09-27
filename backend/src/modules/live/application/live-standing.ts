import { Inject, Injectable } from '@nestjs/common';

import type { Principal } from '../../../shared';
import {
  COMMUNITY_AUTHORIZATION,
  MAX_AUTHORIZE_BATCH,
  type CommunityAuthorization,
} from '../../communities/contracts/authorization';
import {
  ACCOUNT_DIRECTORY,
  AUTHORIZATION_SERVICE,
  Permissions,
  type AccountDirectory,
  type AuthorizationService,
} from '../../identity/contracts';
import type { LiveSession } from '../domain/live-session';
import {
  PRESENTER_GRANT_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
  type PresenterGrantRepository,
  type SpeakerRequestRepository,
} from '../domain/ports';
import type { PresenterGrant } from '../domain/presenter-grant';
import type { SpeakerRequest } from '../domain/speaker-request';
import type { ParticipantStanding } from '../domain/standing';

/** A signed-in caller's standing, with the records it was read from. */
export interface PrincipalStanding {
  readonly standing: ParticipantStanding;
  /** The caller's open (pending or granted) request, if any. */
  readonly hand: SpeakerRequest | null;
  /** The session's open presenter grant — whoever holds it. */
  readonly presenter: PresenterGrant | null;
}

/** An account's standing, decided with no principal. */
export interface AccountStanding {
  readonly standing: ParticipantStanding;
  /**
   * Eligible to stay (design §3.6): Communities permits
   * `community.live.remain` — the ceiling and basis of joining, gated by
   * `runningLiveContinues` — or they moderate the session.
   */
  readonly eligible: boolean;
}

/**
 * Where people stand in a session right now (live.md §3.6) — asked the same
 * way by every path that turns standing into media rights, so a join token
 * and a pushed permission set can never disagree about who may publish.
 * Recomputed on every call; nothing is stored or cached, and nothing is taken
 * from what a client says.
 *
 * Identity's `live.speak` is asked with no context at all: Live passes no
 * `ownerUserId` anywhere, so no identity rule written for a resource can bind
 * it (live.md §7.4).
 */
@Injectable()
export class LiveStanding {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    @Inject(COMMUNITY_AUTHORIZATION) private readonly communities: CommunityAuthorization,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
    @Inject(PRESENTER_GRANT_REPOSITORY) private readonly presenters: PresenterGrantRepository,
  ) {}

  /**
   * A signed-in caller's standing — the join path and the session view.
   * `moderator` is `LiveAccess`'s answer for this request; the rest is
   * identity's `live.speak` and two point reads, whatever the session's size.
   */
  async ofPrincipal(
    principal: Principal,
    session: LiveSession,
    moderator: boolean,
  ): Promise<PrincipalStanding> {
    const hand = await this.requests.findOpen(session.id, principal.userId);
    const presenter = await this.presenters.active(session.id);
    return {
      standing: {
        moderator,
        publishesByRight: moderator && this.identity.can(principal, Permissions.live.speak),
        speakerGrant: hand?.state === 'granted',
        presenter: presenter?.userId === principal.userId,
      },
      hand,
      presenter,
    };
  }

  /**
   * Accounts' standing with no principal — a pushed permission set, a
   * grant's target, the reconciler. At most MAX_AUTHORIZE_BATCH ids
   * (RangeError above); the answer holds every distinct id asked about.
   *
   * Communities decides eligibility and moderation in batches
   * (`permittedAmong` for `community.live.remain`, `community.live.moderate`,
   * and the host's `community.live.host`); identity decides `live.speak`
   * (`withPermission`, which also drops suspended accounts); Live's own rows
   * give the floor (at most MAX_CONCURRENT_SPEAKERS) and the presenter slot.
   * Live applies no ceiling, membership or lifecycle rule of its own.
   *
   * A failure of any of them rejects: "could not tell" never reads as "not
   * eligible", so nobody is refused or demoted on unknown state.
   */
  async ofAccounts(
    session: LiveSession,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, AccountStanding>> {
    if (userIds.length > MAX_AUTHORIZE_BATCH) {
      throw new RangeError(`ofAccounts takes at most ${MAX_AUTHORIZE_BATCH} user ids.`);
    }
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const { communityId, hostUserId } = session;
    const remain = new Set(
      await this.communities.permittedAmong(communityId, ids, 'community.live.remain'),
    );
    const moderators = new Set(
      await this.communities.permittedAmong(communityId, ids, 'community.live.moderate'),
    );
    if (ids.includes(hostUserId) && !moderators.has(hostUserId)) {
      const host = await this.communities.permittedAmong(
        communityId,
        [hostUserId],
        'community.live.host',
      );
      if (host.includes(hostUserId)) moderators.add(hostUserId);
    }
    const speakByRight =
      moderators.size === 0
        ? new Set<string>()
        : await this.directory.withPermission([...moderators], Permissions.live.speak);
    const granted = new Set(
      (await this.requests.granted(session.id)).map((request) => request.userId),
    );
    const presenter = (await this.presenters.active(session.id))?.userId ?? null;

    return new Map(
      ids.map((userId) => [
        userId,
        {
          standing: {
            moderator: moderators.has(userId),
            publishesByRight: moderators.has(userId) && speakByRight.has(userId),
            speakerGrant: granted.has(userId),
            presenter: presenter === userId,
          },
          eligible: remain.has(userId) || moderators.has(userId),
        },
      ]),
    );
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';

import { err, ok, type Failure, type Principal, type Result } from '../../../shared';
import {
  COMMUNITY_AUTHORIZATION,
  type CommunityAuthorization,
  type CommunityPermit,
} from '../../communities/contracts/authorization';
import type { CommunityAct } from '../../communities/contracts/capabilities';
import { askCommunities } from './community-calls';
import { LiveRefusals } from './live-settings';

/**
 * What access to a session is decided on: the community, read from Live's
 * own record (never from a client), and the session's host. Null before a
 * session exists — the community's current-session route — when nobody is
 * a host.
 */
export interface LiveScope {
  readonly communityId: string;
  readonly hostUserId: string | null;
}

/**
 * Communities' answers for one principal about one session, asked together
 * because every caller of `participation` needs both: whether they may take
 * part, and whether they moderate.
 */
export interface Participation {
  /** The `community.live.join` permit; null when it was refused. */
  readonly join: CommunityPermit | null;
  /**
   * Join was refused by the community's lifecycle alone: a member, under a
   * status that closes new joins. They may still see the session.
   */
  readonly joinClosed: boolean;
  /**
   * Communities' code for refusing `community.live.join`; null when it
   * permitted it. For logs only (P7.2 decision Q-A): a route answers a
   * non-member, a member of another community and a removed member alike,
   * and Communities itself answers all three `communities.community_not_found`.
   */
  readonly joinRefusal: string | null;
  /** The moderator permit (`community.live.moderate`, or the host's `community.live.host`). */
  readonly moderator: CommunityPermit | null;
}

/** May take part now: a join permit, or a moderator. */
export function takesPart(participation: Participation): boolean {
  return participation.join !== null || participation.moderator !== null;
}

/** May see the session: taking part, or refused a join only by the lifecycle. */
export function sees(participation: Participation): boolean {
  return takesPart(participation) || participation.joinClosed;
}

/** What an audit entry records of the permit an act ran on (design §7.2). */
export function permitOf(permit: CommunityPermit): Readonly<Record<string, unknown>> {
  return {
    act: permit.act,
    basis: permit.basis,
    membershipId: permit.membership?.membershipId ?? null,
    grantId: permit.grantId,
  };
}

/** An answer that is the 503 of an outage. */
type Outage = { readonly ok: false; readonly error: Failure & { readonly kind: 'unavailable' } };

/**
 * Whether an answer is an outage — told apart from Communities' own
 * refusals, which are never `unavailable`.
 */
export function isOutage<T>(answer: Result<T>): answer is Result<T> & Outage {
  return !answer.ok && answer.error.kind === 'unavailable';
}

/**
 * How Live decides who moderates and who takes part (live.md §7.2), asking
 * COMMUNITY_AUTHORIZATION on every request — nothing is cached across
 * requests, and Live keeps no copy of any Communities rule.
 *
 * A moderator, in this order:
 *
 *   1. `community.live.moderate` permits — the owner, or a delegate holding
 *      the capability: a moderator of every session of the community;
 *   2. otherwise, for the session's host only, `community.live.host` permits
 *      — backed by `community.live.start`, and allowed while a running
 *      session continues;
 *   3. otherwise a refusal, from the first answer:
 *
 *        no stint, or no ceiling   404, the route's own not-found code —
 *                                  identical to a session that does not exist
 *        a member without it       403 live.not_a_moderator
 *        Communities unreachable   503 unavailable
 *
 * There is no institution-wide override: an all-permission principal with
 * no standing in the community is refused like anyone else (ADR 0017).
 *
 * A participant: a `community.live.join` permit, or a moderator — with the
 * lifecycle's refusal reported on its own (412 live.community_not_open).
 *
 * The permit is returned, so the act's audit entry records exactly which
 * standing it ran on: `{act, basis, membershipId, grantId}`.
 */
@Injectable()
export class LiveAccess {
  private readonly logger = new Logger(LiveAccess.name);

  constructor(
    @Inject(COMMUNITY_AUTHORIZATION) private readonly communities: CommunityAuthorization,
  ) {}

  /**
   * One act, asked afresh. A refusal comes back as Communities gave it; an
   * outage as 503 `unavailable` (`isOutage`).
   */
  ask(
    principal: Principal,
    communityId: string,
    act: CommunityAct,
  ): Promise<Result<CommunityPermit>> {
    return askCommunities(this.logger, () =>
      this.communities.authorize(principal, communityId, act),
    ).then((answer) => (answer.ok ? answer.value : answer));
  }

  /** The moderator permit, or the refusal the route answers (404 `notFound`, 403, 503). */
  async moderator(
    principal: Principal,
    scope: LiveScope,
    notFound: Failure,
  ): Promise<Result<CommunityPermit>> {
    const answer = await this.moderatorAnswer(principal, scope);
    if (answer.ok || isOutage(answer)) return answer;
    // A member without either act is refused as such; anyone else — no stint
    // in the community, or no identity ceiling — exactly as if the session did
    // not exist.
    return err(
      answer.error.code === 'communities.capability_required'
        ? LiveRefusals.notAModerator
        : notFound,
    );
  }

  /** Both answers, never refused here: only an outage fails (503). */
  async participation(principal: Principal, scope: LiveScope): Promise<Result<Participation>> {
    const join = await this.ask(principal, scope.communityId, 'community.live.join');
    if (isOutage(join)) return join;
    const moderator = await this.moderatorAnswer(principal, scope);
    if (isOutage(moderator)) return moderator;
    return ok({
      join: join.ok ? join.value : null,
      joinClosed: !join.ok && join.error.kind === 'precondition_failed',
      joinRefusal: join.ok ? null : join.error.code,
      moderator: moderator.ok ? moderator.value : null,
    });
  }

  /** A participant, or 404 `notFound`, or 412 live.community_not_open, or 503. */
  async participant(
    principal: Principal,
    scope: LiveScope,
    notFound: Failure,
  ): Promise<Result<Participation>> {
    const answer = await this.participation(principal, scope);
    if (!answer.ok || takesPart(answer.value)) return answer;
    return err(answer.value.joinClosed ? LiveRefusals.communityNotOpen : notFound);
  }

  /** Someone who may see the session — its views, and a lowered hand's answer — or 404, or 503. */
  async viewer(
    principal: Principal,
    scope: LiveScope,
    notFound: Failure,
  ): Promise<Result<Participation>> {
    const answer = await this.participation(principal, scope);
    if (!answer.ok || sees(answer.value)) return answer;
    return err(notFound);
  }

  /** Steps 1 and 2, answered as Communities answered step 1 when neither permits. */
  private async moderatorAnswer(
    principal: Principal,
    scope: LiveScope,
  ): Promise<Result<CommunityPermit>> {
    const moderate = await this.ask(principal, scope.communityId, 'community.live.moderate');
    if (moderate.ok || isOutage(moderate) || principal.userId !== scope.hostUserId) {
      return moderate;
    }
    const host = await this.ask(principal, scope.communityId, 'community.live.host');
    return host.ok || isOutage(host) ? host : moderate;
  }
}

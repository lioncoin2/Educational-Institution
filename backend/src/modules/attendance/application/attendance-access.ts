import { Inject, Injectable, Logger } from '@nestjs/common';

import { err, type Failure, type Principal, type Result } from '../../../shared';
import {
  COMMUNITY_AUTHORIZATION,
  type CommunityAuthorization,
  type CommunityPermit,
} from '../../communities/contracts/authorization';
import type { CommunityAct } from '../../communities/contracts/capabilities';
import { AttendanceRefusals } from './attendance-settings';

/**
 * The facts the record decision needs. Read by the use case from Live's own
 * record (`LIVE_SESSIONS.describe`) — never from a client, and never by this
 * class, so attendance imports no Live internals and reads no store here.
 */
export interface AttendanceRecordScope {
  readonly communityId: string;
  /** The live session's host, for the `community.live.host` fallback step (§11.3). */
  readonly hostUserId: string;
}

/** The facts the single-snapshot view decision needs, from the stored header / idempotency index. */
export interface AttendanceSnapshotScope {
  readonly communityId: string;
  /**
   * Whether the principal is the snapshot header's `hostUserId`, or recorded a
   * snapshot of the same session (the idempotency-index prefix read the use
   * case does). Only then may a refused `community.attendance.view` fall back to
   * `community.view` on the membership basis (§11.3).
   */
  readonly recorderOrHost: boolean;
}

/** The facts the community-list view decision needs. */
export interface AttendanceListScope {
  readonly communityId: string;
  /** Whether the principal hosted or recorded in a session of this community (§11.3). */
  readonly hostedOrRecorded: boolean;
}

/** How a path maps Communities' refusals to attendance's own (attendance.md §11.3). */
interface RefusalMap {
  /** Unknown community, no stint, or no identity ceiling — the caller learns nothing. */
  readonly notFound: Failure;
  /** A member of the community who holds no act in the fallback order. */
  readonly memberRefusal: Failure;
}

const RECORD_MAP: RefusalMap = {
  notFound: AttendanceRefusals.sessionNotFound,
  memberRefusal: AttendanceRefusals.notAllowed,
};
const LIST_MAP: RefusalMap = {
  notFound: AttendanceRefusals.communityNotFound,
  memberRefusal: AttendanceRefusals.notAllowed,
};
// One snapshot: a member without the view act is answered 404, never 403 — a
// 403 would reveal the snapshot exists (attendance.md §11.3).
const SNAPSHOT_MAP: RefusalMap = {
  notFound: AttendanceRefusals.snapshotNotFound,
  memberRefusal: AttendanceRefusals.snapshotNotFound,
};

/** What an audit entry records of the permit an act ran on (attendance.md §11.3). */
export function permitOf(permit: CommunityPermit): Readonly<Record<string, unknown>> {
  return {
    act: permit.act,
    basis: permit.basis,
    membershipId: permit.membership?.membershipId ?? null,
    grantId: permit.grantId,
  };
}

function isOutage(answer: Result<CommunityPermit>): boolean {
  return !answer.ok && answer.error.kind === 'unavailable';
}

/**
 * `AttendanceAccess` — the attendance module's one authorization gate
 * (attendance.md §11.3), wrapping `COMMUNITY_AUTHORIZATION.authorize` exactly as
 * Live's `LiveAccess` and Messaging's `ConversationAccess` do. Asked afresh on
 * every request: nothing is cached, and attendance keeps no copy of any
 * Communities rule.
 *
 * Scope facts (the community, the session host, whether the caller recorded or
 * hosted) are PASSED IN by the use case, which reads them from Live's record and
 * the stored snapshot header — never from a client, and never here — so this
 * class imports no Live internals and reads no store.
 *
 * It uses **no `attendance.*` identity permission** (attendance.md §11.2):
 * authorization is community standing only, through the two community acts
 * `community.attendance.record` / `community.attendance.view`.
 *
 * **Option B (ADR 0023 / Q69a, owner 2026-10-05).** Attendance authorization
 * combines the academic relationship AND community standing — the academic one
 * an ADDITIONAL gate that never replaces community standing. That academic gate
 * applies only where an *established* community↔halaqa link exists, which is
 * [Q50], deferred and untouched: no community carries a halaqa today, and
 * attendance must not import academic (the §4 firewall). So in this build there
 * is no academic relationship to consult, its absence never fails authorization,
 * and community standing is the effective authorization. When Q50 later
 * establishes such a link, the academic gate is added WITHOUT replacing anything
 * here — this class makes no academic call and names no halaqa.
 */
@Injectable()
export class AttendanceAccess {
  private readonly logger = new Logger(AttendanceAccess.name);

  constructor(
    @Inject(COMMUNITY_AUTHORIZATION) private readonly communities: CommunityAuthorization,
  ) {}

  /**
   * May this principal record a snapshot of this session? The §11.3 order:
   * `community.attendance.record`, then `community.live.moderate`, then — for
   * the session's host only — `community.live.host`. The winning permit comes
   * back for the audit entry; otherwise the refusal mapped to the record path.
   */
  async record(
    principal: Principal,
    scope: AttendanceRecordScope,
  ): Promise<Result<CommunityPermit>> {
    const base = ['community.attendance.record', 'community.live.moderate'] as const;
    const acts =
      principal.userId === scope.hostUserId ? ([...base, 'community.live.host'] as const) : base;
    const answer = await this.firstPermitOrRefusal(principal, scope.communityId, acts);
    return answer.ok || isOutage(answer) ? answer : err(mapRefusal(answer.error, RECORD_MAP));
  }

  /** May this principal view one snapshot (or its participants)? §11.3. */
  snapshotView(
    principal: Principal,
    scope: AttendanceSnapshotScope,
  ): Promise<Result<CommunityPermit>> {
    return this.viewAccess(principal, scope.communityId, scope.recorderOrHost, SNAPSHOT_MAP);
  }

  /** May this principal view the community's snapshot list? §11.3. */
  listView(principal: Principal, scope: AttendanceListScope): Promise<Result<CommunityPermit>> {
    return this.viewAccess(principal, scope.communityId, scope.hostedOrRecorded, LIST_MAP);
  }

  /**
   * `community.attendance.view`, then — only for a host or a recorder of the
   * session — `community.view` on the **membership basis** (§11.3): an ACTIVE
   * stint admits, never oversight (§11.2), so a former member and an
   * institutional overseer both see nothing.
   */
  private async viewAccess(
    principal: Principal,
    communityId: string,
    mayUseMembership: boolean,
    map: RefusalMap,
  ): Promise<Result<CommunityPermit>> {
    const view = await this.ask(principal, communityId, 'community.attendance.view');
    if (view.ok || isOutage(view)) return view;
    // Move on only on `forbidden`; a not_found or a lock is the final answer.
    if (view.error.kind !== 'forbidden' || !mayUseMembership) {
      return err(mapRefusal(view.error, map));
    }
    const member = await this.ask(principal, communityId, 'community.view');
    if (isOutage(member)) return member;
    if (member.ok && member.value.membership !== null) return member;
    // Neither permits (or only oversight): the first act's refusal, as Live does.
    return err(mapRefusal(view.error, map));
  }

  /**
   * The acts in order: the first that permits wins; a not_found, a lock or an
   * outage is returned at once; a `forbidden` moves to the next; and when every
   * act is forbidden the first refusal is returned (as Live's `LiveAccess` does).
   */
  private async firstPermitOrRefusal(
    principal: Principal,
    communityId: string,
    acts: readonly [CommunityAct, ...CommunityAct[]],
  ): Promise<Result<CommunityPermit>> {
    const [head, ...rest] = acts;
    const first = await this.ask(principal, communityId, head);
    if (first.ok || isOutage(first) || first.error.kind !== 'forbidden') return first;
    for (const act of rest) {
      const next = await this.ask(principal, communityId, act);
      if (next.ok || isOutage(next) || next.error.kind !== 'forbidden') return next;
    }
    return first;
  }

  /** One act, asked afresh; a rejected promise (store down) fails closed as 503. */
  private async ask(
    principal: Principal,
    communityId: string,
    act: CommunityAct,
  ): Promise<Result<CommunityPermit>> {
    try {
      return await this.communities.authorize(principal, communityId, act);
    } catch (error) {
      this.logger.error(
        {
          event: 'attendance.communities.unavailable',
          err: { name: error instanceof Error ? error.name : typeof error },
        },
        'Communities could not answer; failing closed',
      );
      return err(AttendanceRefusals.unavailable);
    }
  }
}

function mapRefusal(error: Failure, map: RefusalMap): Failure {
  if (error.kind === 'precondition_failed') return AttendanceRefusals.communityNotOpen;
  if (error.code === 'communities.capability_required') return map.memberRefusal;
  // not_found, or no identity ceiling (`identity.permission_denied`): the same
  // not-found, so a caller with no standing never learns the id exists (§11.3).
  return map.notFound;
}

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  err,
  ok,
  type CallMetadata,
  type Clock,
  type IdGenerator,
  type Principal,
  type Result,
} from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  Permissions,
  type AuthorizationService,
} from '../../identity/contracts';
import { screenShareStarted, screenShareStopped } from '../domain/events';
import { MAX_CONCURRENT_PRESENTERS } from '../domain/live-limits';
import { isLive, type LiveSession } from '../domain/live-session';
import type { ModerationAction } from '../domain/moderation';
import {
  LIVE_SESSION_REPOSITORY,
  PRESENTER_GRANT_REPOSITORY,
  type LiveSessionRepository,
  type PresenterGrantRepository,
} from '../domain/ports';
import { newPresenterGrant } from '../domain/presenter-grant';
import { LiveAccess, permitOf } from './live-access';
import { LiveJournal, moderationAudit } from './live-journal';
import { LiveMedia, type PushOutcome } from './live-media';
import { LiveRefusals, isLiveId } from './live-settings';
import { LiveSessionViews } from './session-views';
import { LiveStanding } from './live-standing';
import type { ClaimResult, LiveSessionView } from './views';

export interface PresenterCommand {
  readonly principal: Principal;
  readonly sessionId: string;
  readonly meta: CallMetadata;
}

/** A moderator's act on another participant's screen share: the delegated grant and the revoke. */
export interface PresenterTargetCommand {
  readonly principal: Principal;
  readonly sessionId: string;
  /** The participant the act is about — the target only; the server decides who may act. */
  readonly targetUserId: string;
  readonly meta: CallMetadata;
}

/**
 * Screen sharing (live.md §6, S4; Q56, ADR 0028): up to
 * MAX_CONCURRENT_PRESENTERS presenters at a time, the cap counted under the
 * session's lock — never a token flag, and never screen audio.
 *
 *   claim   a by-right presenter claims for themself: a moderator
 *           (`LiveAccess`) holding `live.speak` (403
 *           live.presenter_not_permitted without it). A slot free → opened,
 *           their full set pushed (the screen on), audited, announced, 201;
 *           already theirs → 200; the cap reached → 409
 *           live.presenter_slots_full; the session ended → 412
 *   grant   a moderator grants a participant (a student) a delegated slot
 *           (`grantedBy` the moderator): the target validated server-side as a
 *           current participant (else 404 live.target_not_in_session), the cap
 *           and lock as `claim`. The student presents by the grant alone,
 *           without `live.speak`; 201 / 200 / 409 / 412 as `claim`
 *   stop    the caller stops their OWN share — no permit, it only reduces
 *           privilege: closed `stopped`, their set pushed (the screen off),
 *           announced but not audited, 200
 *   revoke  a moderator closes a target's grant: nothing open → 200; the
 *           host's grant, and the moderator is not the host → 403
 *           live.target_is_host (Q54); otherwise closed `revoked`, with its
 *           moderation row, the target's set pushed, audited, announced, 200
 *
 * Every answer is the session's view as the caller now sees it.
 */
@Injectable()
export class PresenterUseCase {
  private readonly logger = new Logger(PresenterUseCase.name);

  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(PRESENTER_GRANT_REPOSITORY) private readonly presenters: PresenterGrantRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly media: LiveMedia,
    private readonly views: LiveSessionViews,
    private readonly journal: LiveJournal,
    private readonly standing: LiveStanding,
  ) {}

  async claim(command: PresenterCommand): Promise<Result<ClaimResult>> {
    const { principal } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.moderate);
    if (!allowed.ok) return allowed;
    if (!isLiveId(command.sessionId)) return err(LiveRefusals.sessionNotFound);

    const session = await this.sessions.findById(command.sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    const permit = await this.access.moderator(principal, session, LiveRefusals.sessionNotFound);
    if (!permit.ok) return permit;
    // Asked with no context: no `ownerUserId`, ever (live.md §7.4).
    if (!this.identity.can(principal, Permissions.live.speak)) {
      return err(LiveRefusals.presenterNotPermitted);
    }

    const at = this.clock.now();
    const action = this.action('grant_presenter', principal, session, principal.userId, at);
    const outcome = await this.presenters.openWithinCap(
      newPresenterGrant({
        id: this.ids.next<'PresenterGrant'>(),
        sessionId: session.id,
        userId: principal.userId,
        grantedBy: principal.userId,
        at,
      }),
      MAX_CONCURRENT_PRESENTERS,
      action,
    );
    switch (outcome.kind) {
      case 'slots_full':
        return err(LiveRefusals.presenterSlotsFull);
      case 'session_not_live':
        return err(LiveRefusals.sessionNotLive);
      case 'held':
        return this.answer(principal, session, false);
      case 'opened':
        break;
    }
    // An opened slot always carries its grant; only `session_not_live` has none.
    const grant = outcome.grant;
    if (grant === null) return err(LiveRefusals.sessionNotLive);

    const media = await this.media.push(session, principal.userId);
    await this.journal.record(
      moderationAudit(action, {
        communityId: session.communityId,
        detail: { presenterGrantId: grant.id, media, permit: permitOf(permit.value) },
        correlationId: command.meta.correlationId,
      }),
      [screenShareStarted(session, grant, outcome.stateVersion, command.meta.correlationId)],
    );
    this.logger.log(
      {
        event: 'live.presenter.claimed',
        sessionId: session.id,
        presenterGrantId: grant.id,
        userId: principal.userId,
        media,
      },
      'the presenter slot was claimed',
    );
    return this.answer(principal, session, true);
  }

  /**
   * A moderator grants a participant (a student) a delegated presenter slot
   * (Q56): `userId` the target, `grantedBy` the moderator. The target is
   * validated server-side as a current participant — the path names them, the
   * server decides who may act. The student presents by this grant alone,
   * without `live.speak`; the grant is session-scoped and revocable.
   */
  async grant(command: PresenterTargetCommand): Promise<Result<ClaimResult>> {
    const { principal, sessionId, targetUserId, meta } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.moderate);
    if (!allowed.ok) return allowed;
    if (!isLiveId(sessionId)) return err(LiveRefusals.sessionNotFound);
    if (!isLiveId(targetUserId)) return err(LiveRefusals.targetNotInSession);

    const session = await this.sessions.findById(sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    const permit = await this.access.moderator(principal, session, LiveRefusals.sessionNotFound);
    if (!permit.ok) return permit;
    if (!isLive(session)) return err(LiveRefusals.sessionNotLive);

    // The target must be someone who may take part now — never trusted from
    // the path, decided by Communities. One 404 whether they exist or not.
    const targetStanding = (await this.standing.ofAccounts(session, [targetUserId])).get(
      targetUserId,
    );
    if (targetStanding === undefined || !targetStanding.eligible) {
      return err(LiveRefusals.targetNotInSession);
    }

    const at = this.clock.now();
    const action = this.action('grant_presenter', principal, session, targetUserId, at);
    const outcome = await this.presenters.openWithinCap(
      newPresenterGrant({
        id: this.ids.next<'PresenterGrant'>(),
        sessionId: session.id,
        userId: targetUserId,
        grantedBy: principal.userId,
        at,
      }),
      MAX_CONCURRENT_PRESENTERS,
      action,
    );
    switch (outcome.kind) {
      case 'slots_full':
        return err(LiveRefusals.presenterSlotsFull);
      case 'session_not_live':
        return err(LiveRefusals.sessionNotLive);
      case 'held':
        return this.answer(principal, session, false);
      case 'opened':
        break;
    }
    const grant = outcome.grant;
    if (grant === null) return err(LiveRefusals.sessionNotLive);

    const media = await this.media.push(session, targetUserId);
    await this.journal.record(
      moderationAudit(action, {
        communityId: session.communityId,
        detail: { presenterGrantId: grant.id, media, permit: permitOf(permit.value) },
        correlationId: meta.correlationId,
      }),
      [screenShareStarted(session, grant, outcome.stateVersion, meta.correlationId)],
    );
    this.logger.log(
      {
        event: 'live.presenter.granted',
        sessionId: session.id,
        presenterGrantId: grant.id,
        userId: targetUserId,
        by: principal.userId,
        media,
      },
      'a presenter slot was granted to a participant',
    );
    return this.answer(principal, session, true);
  }

  /** The caller stops their OWN share — no permit; it only reduces their own privilege. */
  async stop(command: PresenterCommand): Promise<Result<LiveSessionView>> {
    const { principal } = command;
    if (!isLiveId(command.sessionId)) return err(LiveRefusals.sessionNotFound);
    const session = await this.sessions.findById(command.sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);

    const closed = await this.presenters.close({
      sessionId: session.id,
      userId: principal.userId,
      by: principal.userId,
      reason: 'stopped',
      at: this.clock.now(),
      moderation: null,
    });
    if (closed.grant !== null) {
      const media = await this.media.push(session, principal.userId);
      await this.journal.record(null, [
        screenShareStopped(session, closed.grant, closed.stateVersion, command.meta.correlationId),
      ]);
      this.closedLog(
        session,
        closed.grant.id,
        principal.userId,
        principal.userId,
        'stopped',
        media,
      );
      return this.view(principal, session);
    }
    // Nothing of theirs was open: the answer must not reveal the session to
    // someone who may not see it (as lowering a hand does) — 404 unless they
    // may view it.
    const viewer = await this.access.viewer(principal, session, LiveRefusals.sessionNotFound);
    return viewer.ok ? this.view(principal, session) : viewer;
  }

  /**
   * A moderator closes a target's grant (Q56): the target named by the path,
   * the server deciding who may act. Nothing open for them → 200 no-op; the
   * host's grant and the caller is not the host → 403 (Q54).
   */
  async revoke(command: PresenterTargetCommand): Promise<Result<LiveSessionView>> {
    const { principal, sessionId, targetUserId, meta } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.moderate);
    if (!allowed.ok) return allowed;
    if (!isLiveId(sessionId)) return err(LiveRefusals.sessionNotFound);
    const session = await this.sessions.findById(sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    const permit = await this.access.moderator(principal, session, LiveRefusals.sessionNotFound);
    if (!permit.ok) return permit;
    if (targetUserId === session.hostUserId && principal.userId !== session.hostUserId) {
      return err(LiveRefusals.targetIsHost);
    }

    const at = this.clock.now();
    const action = this.action('revoke_presenter', principal, session, targetUserId, at);
    const closed = await this.presenters.close({
      sessionId: session.id,
      userId: targetUserId,
      by: principal.userId,
      reason: 'revoked',
      at,
      moderation: action,
    });
    if (closed.grant !== null) {
      const media = await this.media.push(session, targetUserId);
      await this.journal.record(
        moderationAudit(action, {
          communityId: session.communityId,
          detail: { presenterGrantId: closed.grant.id, media, permit: permitOf(permit.value) },
          correlationId: meta.correlationId,
        }),
        [screenShareStopped(session, closed.grant, closed.stateVersion, meta.correlationId)],
      );
      this.closedLog(session, closed.grant.id, targetUserId, principal.userId, 'revoked', media);
    }
    return this.view(principal, session);
  }

  /** The slot closed, as a log line (P7.2): ids, why, and the media outcome only. */
  private closedLog(
    session: LiveSession,
    presenterGrantId: string,
    userId: string,
    by: string,
    reason: 'stopped' | 'revoked',
    media: PushOutcome,
  ): void {
    this.logger.log(
      {
        event: 'live.presenter.closed',
        sessionId: session.id,
        presenterGrantId,
        userId,
        by,
        reason,
        media,
      },
      'the presenter slot was closed',
    );
  }

  private action(
    type: 'grant_presenter' | 'revoke_presenter',
    principal: Principal,
    session: LiveSession,
    targetUserId: string,
    at: Date,
  ): ModerationAction {
    return {
      id: this.ids.next<'ModerationAction'>(),
      sessionId: session.id,
      actorUserId: principal.userId,
      targetUserId,
      type,
      at,
    };
  }

  private async answer(
    principal: Principal,
    session: LiveSession,
    opened: boolean,
  ): Promise<Result<ClaimResult>> {
    const view = await this.view(principal, session);
    return view.ok ? ok({ opened, session: view.value }) : view;
  }

  /** The session as it is now — re-read, so the view carries the version the change produced. */
  private async view(principal: Principal, session: LiveSession): Promise<Result<LiveSessionView>> {
    const current = await this.sessions.findById(session.id);
    return this.views.forCaller(principal, current ?? session);
  }
}

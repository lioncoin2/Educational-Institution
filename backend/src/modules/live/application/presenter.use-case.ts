import { Inject, Injectable } from '@nestjs/common';

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
import type { LiveSession } from '../domain/live-session';
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
import { LiveMedia } from './live-media';
import { LiveRefusals } from './live-settings';
import { LiveSessionViews } from './session-views';
import type { ClaimResult, LiveSessionView } from './views';

export interface PresenterCommand {
  readonly principal: Principal;
  readonly sessionId: string;
  readonly meta: CallMetadata;
}

/**
 * The screen-share slot (live.md §6, S4; PROVISIONAL, Q56): one presenter at
 * a time, a session moderator holding `live.speak`, for themself — never a
 * token flag, and never screen audio.
 *
 *   claim             a moderator (`LiveAccess`), holding `live.speak` (403
 *                     live.presenter_not_permitted without it). The slot,
 *                     read under the session's lock: free → opened, their
 *                     full set pushed (the screen on), audited, announced,
 *                     201; already theirs → 200; someone else's → 409
 *                     live.presenter_slot_taken; the session ended → 412
 *   stop, presenter   no permit needed — it only reduces privilege: closed
 *                     `stopped`, their set pushed (the screen off), announced
 *                     but not audited, 200
 *   stop, anyone else a moderator: nothing open → 200; the host's grant,
 *                     and the moderator is not the host → 403
 *                     live.target_is_host (Q54); otherwise closed `revoked`,
 *                     with its moderation row, the presenter's set pushed,
 *                     audited, announced, 200
 *
 * Every answer is the session's view as the caller now sees it.
 */
@Injectable()
export class PresenterUseCase {
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
  ) {}

  async claim(command: PresenterCommand): Promise<Result<ClaimResult>> {
    const { principal } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.moderate);
    if (!allowed.ok) return allowed;

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
    const outcome = await this.presenters.open(
      newPresenterGrant({
        id: this.ids.next<'PresenterGrant'>(),
        sessionId: session.id,
        userId: principal.userId,
        at,
      }),
      action,
    );
    switch (outcome.kind) {
      case 'occupied':
        return err(LiveRefusals.presenterSlotTaken);
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
    return this.answer(principal, session, true);
  }

  async stop(command: PresenterCommand): Promise<Result<LiveSessionView>> {
    const { principal } = command;
    const session = await this.sessions.findById(command.sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);

    const holding = await this.presenters.active(session.id);
    if (holding !== null && holding.userId === principal.userId) {
      const closed = await this.presenters.close({
        sessionId: session.id,
        userId: principal.userId,
        by: principal.userId,
        reason: 'stopped',
        at: this.clock.now(),
        moderation: null,
      });
      if (closed.grant !== null) {
        await this.media.push(session, principal.userId);
        await this.journal.record(null, [
          screenShareStopped(
            session,
            closed.grant,
            closed.stateVersion,
            command.meta.correlationId,
          ),
        ]);
      }
      return this.view(principal, session);
    }

    const permit = await this.access.moderator(principal, session, LiveRefusals.sessionNotFound);
    if (!permit.ok) return permit;
    if (holding === null) return this.view(principal, session);
    if (holding.userId === session.hostUserId && principal.userId !== session.hostUserId) {
      return err(LiveRefusals.targetIsHost);
    }

    const at = this.clock.now();
    const action = this.action('revoke_presenter', principal, session, holding.userId, at);
    const closed = await this.presenters.close({
      sessionId: session.id,
      userId: holding.userId,
      by: principal.userId,
      reason: 'revoked',
      at,
      moderation: action,
    });
    if (closed.grant !== null) {
      const media = await this.media.push(session, holding.userId);
      await this.journal.record(
        moderationAudit(action, {
          communityId: session.communityId,
          detail: { presenterGrantId: closed.grant.id, media, permit: permitOf(permit.value) },
          correlationId: command.meta.correlationId,
        }),
        [
          screenShareStopped(
            session,
            closed.grant,
            closed.stateVersion,
            command.meta.correlationId,
          ),
        ],
      );
    }
    return this.view(principal, session);
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

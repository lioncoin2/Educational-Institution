import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  err,
  ok,
  type CallMetadata,
  type Clock,
  type DomainEvent,
  type IdGenerator,
  type Principal,
  type Result,
} from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  Permissions,
  type AuthorizationService,
} from '../../identity/contracts';
import { mediaReset as mediaResetEvent } from '../domain/events';
import { isLive } from '../domain/live-session';
import type { ModerationAction } from '../domain/moderation';
import { LIVE_SESSION_REPOSITORY, type LiveSessionRepository } from '../domain/ports';
import { errorName } from './live-reconciler-runtime';
import { LiveAccess, permitOf } from './live-access';
import { LiveMediaReset } from './live-media-reset';
import { LiveRefusals, isLiveId } from './live-settings';
import type { ResetRoomResult } from './views';

export interface ResetRoomCommand {
  readonly principal: Principal;
  readonly sessionId: string;
  readonly meta: CallMetadata;
}

/**
 * A moderator resets a live session's media room (Q64, ADR 0026): the very
 * epoch bump + room swap the reconciler uses (`LiveMediaReset`), commanded.
 *
 *   1. identity's coarse `live.moderate`;
 *   2. a malformed session id → 404, before any store call;
 *   3. the session → 404, or 412 live.session_not_live after the end;
 *   4. `LiveAccess.moderator` → 404 / 403 live.not_a_moderator / 503;
 *   5. the shared reset: the compare-and-set epoch bump (its `reset_media` row,
 *      the moderator the actor), the new room ensured and the old one deleted.
 *      The epoch is committed before the provider calls, so a provider outage
 *      is left to the room sweep — the reset still holds, because every current
 *      token names the deleted old room and `auto_create` is off. A null bump —
 *      a concurrent reset or the end won — answers `reset: false`;
 *   6. the `live.session.media_reset` fact, delivered to the session's current
 *      participants so they re-join the new room; audited with the permit.
 *
 * It removes no one and keeps no ban: everyone re-joins the new generation
 * through `/join`. Why the whole reserve belongs to a moderator and not a
 * single participant is Q64.
 */
@Injectable()
export class ResetRoomUseCase {
  private readonly logger = new Logger(ResetRoomUseCase.name);

  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    private readonly mediaReset: LiveMediaReset,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: ResetRoomCommand): Promise<Result<ResetRoomResult>> {
    const { principal, sessionId, meta } = command;

    const allowed = this.identity.authorize(principal, Permissions.live.moderate);
    if (!allowed.ok) return allowed;
    if (!isLiveId(sessionId)) return err(LiveRefusals.sessionNotFound);

    const session = await this.sessions.findById(sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    if (!isLive(session)) return err(LiveRefusals.sessionNotLive);

    const permit = await this.access.moderator(principal, session, LiveRefusals.sessionNotFound);
    if (!permit.ok) return permit;

    const now = this.clock.now();
    const action: ModerationAction = {
      id: this.ids.next<'ModerationAction'>(),
      sessionId: session.id,
      actorUserId: principal.userId,
      targetUserId: null,
      type: 'reset_media',
      at: now,
    };
    const moved = await this.mediaReset.reset({
      session,
      action,
      detail: { permit: permitOf(permit.value) },
      correlationId: meta.correlationId,
      eventsFor: (from, to): readonly DomainEvent[] => [
        mediaResetEvent(
          from,
          from.mediaRoomEpoch,
          to.mediaRoomEpoch,
          principal.userId,
          now,
          meta.correlationId,
        ),
      ],
      hooks: {
        runProvider: (call) => call(),
        onSkipped: (error) =>
          this.logger.error(
            {
              event: 'live.session.media_reset_skipped',
              sessionId: session.id,
              err: { name: errorName(error) },
            },
            'the media room reset committed, but a provider call did not; the room sweep converges it',
          ),
      },
    });
    if (moved === null) return ok({ reset: false });

    this.logger.warn(
      {
        event: 'live.session.media_reset',
        sessionId: session.id,
        by: principal.userId,
        fromEpoch: session.mediaRoomEpoch,
        toEpoch: moved.mediaRoomEpoch,
      },
      'a moderator reset the live session’s media room',
    );
    return ok({ reset: true });
  }
}

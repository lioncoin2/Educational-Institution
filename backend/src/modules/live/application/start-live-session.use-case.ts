import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  RATE_LIMITER,
  err,
  ok,
  type CallMetadata,
  type Clock,
  type Failure,
  type IdGenerator,
  type Principal,
  type RateLimiter,
  type Result,
} from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  Permissions,
  type AuthorizationService,
} from '../../identity/contracts';
import { liveSessionStarted } from '../domain/events';
import {
  LiveRateLimits,
  ROOM_PROVIDER_TIMEOUT_SECONDS,
  ROOM_SWEEP_SECONDS,
} from '../domain/live-limits';
import { currentMediaRoom, newLiveSession, type LiveSession } from '../domain/live-session';
import type { ModerationAction } from '../domain/moderation';
import { LIVE_SESSION_REPOSITORY, type LiveSessionRepository } from '../domain/ports';
import { RTC_ROOMS, RtcUnavailableError, type RtcRoomProvider } from '../domain/rtc-provider';
import { LiveAccess, isOutage, permitOf } from './live-access';
import { LiveJournal, moderationAudit } from './live-journal';
import { LiveMediaReadiness } from './live-media-readiness';
import {
  LIVE_SETTINGS,
  LiveRefusals,
  mediaRefusal,
  notReadyRefusal,
  tooMany,
  type LiveSettings,
} from './live-settings';
import { LiveSessionViews } from './session-views';
import type { StartResult } from './views';

/**
 * Starts the community's live session (live.md §4.1, S1; audit D1, D20) —
 * idempotent, and provider first:
 *
 *   1. identity's `live.moderate` — the route's gate, asked again because a
 *      job or a handler bypasses it — then the caller's own limit: 10 starts
 *      a minute (429 live.too_many_starts);
 *   2. `community.live.start`, asked of Communities for the community in the
 *      path: not found → 404 live.community_not_found; forbidden → 403
 *      live.start_not_permitted; the lifecycle's refusal (LOCKED) → 200 with
 *      the running session if there is one — a start retried after a lock —
 *      else 412 live.community_not_open;
 *   3. a session already running → 200 with it, and nothing else happens;
 *   4. the media room first. The provider's readiness, no older than a room
 *      sweep (`LiveMediaReadiness`, P7.1), then `ensureRoom`, sized to the
 *      cap plus the reserve. A provider that is not ready, or a failed
 *      `ensureRoom`, answers 503 with NOTHING stored — no room, no row, no
 *      audit, no event (P7.2, Q-B): live.media_unavailable for an outage or
 *      the disabled provider of a deployment without real media (D19), which
 *      waiting may fix; live.media_misconfigured for refused credentials, a
 *      TLS failure, a wrong endpoint or a server with auto-create on, which
 *      an operator must;
 *   5. `community.live.start` asked AGAIN (D20), so a lock or a removal that
 *      committed during the provider call is honoured: a refusal now ends the
 *      room this call ensured (best effort) and answers as in step 2;
 *   6. the insert, which admits one live session per community: a start that
 *      lost a race ends the room it ensured (best effort) and answers 200
 *      with the winner;
 *   7. created: the audit entry, with the permit it ran on, then
 *      `live.session.started`; 201. The starter is the host.
 *
 * No transaction ever spans a provider call. A crash between steps 4 and 6
 * leaves an orphan room, which the room sweep ends after its grace.
 */
@Injectable()
export class StartLiveSessionUseCase {
  private readonly logger = new Logger(StartLiveSessionUseCase.name);

  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(RTC_ROOMS) private readonly rooms: RtcRoomProvider,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(LIVE_SETTINGS) private readonly settings: LiveSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly views: LiveSessionViews,
    private readonly journal: LiveJournal,
    private readonly readiness: LiveMediaReadiness,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<StartResult>> {
    const { principal, communityId } = command;
    // Re-asked here because jobs and handlers bypass the route's guard.
    const allowed = this.identity.authorize(principal, Permissions.live.moderate);
    if (!allowed.ok) return allowed;

    const throttle = await this.limiter.consume(principal.userId, LiveRateLimits.startsPerUser);
    if (!throttle.allowed) {
      return err(tooMany('live.too_many_starts', throttle.retryAfterSeconds));
    }

    const permitted = await this.access.ask(principal, communityId, 'community.live.start');
    if (isOutage(permitted)) return permitted;
    if (!permitted.ok) return this.refused(principal, communityId, permitted.error);

    const running = await this.sessions.findLiveByCommunity(communityId);
    if (running !== null) return this.answer(principal, running, false);

    const session = newLiveSession({
      id: this.ids.next<'LiveSession'>(),
      communityId,
      hostUserId: principal.userId,
      at: this.clock.now(),
      participantCap: this.settings.participantCap,
      moderatorReserve: this.settings.moderatorReserve,
    });
    const room = currentMediaRoom(this.settings.roomNamePrefix, session);
    const readiness = await this.readiness.ensureFresh(ROOM_SWEEP_SECONDS * 1000);
    if (!readiness.ready) return err(notReadyRefusal(readiness.reason));
    try {
      await this.rooms.ensureRoom({
        roomName: room,
        maxParticipants: session.participantCap + session.moderatorReserve,
        emptyTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
        departureTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
      });
    } catch (error) {
      const refusal = mediaRefusal(error);
      if (refusal !== null) return err(refusal);
      throw error;
    }

    // Asked again: the provider call took time, and a lock or a removal may
    // have committed meanwhile.
    const still = await this.access.ask(principal, communityId, 'community.live.start');
    if (!still.ok) {
      await this.endStrayRoom(room, session);
      return isOutage(still) ? still : this.refused(principal, communityId, still.error);
    }

    const moderation: ModerationAction = {
      id: this.ids.next<'ModerationAction'>(),
      sessionId: session.id,
      actorUserId: principal.userId,
      targetUserId: null,
      type: 'start_session',
      at: session.startedAt,
    };
    const outcome = await this.sessions.start(session, moderation);
    if (!outcome.created) {
      // A concurrent start won: this call's room is nobody's.
      await this.endStrayRoom(room, session);
      return this.answer(principal, outcome.session, false);
    }

    await this.journal.record(
      moderationAudit(moderation, {
        communityId,
        detail: { permit: permitOf(still.value) },
        correlationId: command.meta.correlationId,
      }),
      [liveSessionStarted(outcome.session, command.meta.correlationId)],
    );
    return this.answer(principal, outcome.session, true);
  }

  /** Communities refused the start, remapped (step 2). */
  private async refused(
    principal: Principal,
    communityId: string,
    refusal: Failure,
  ): Promise<Result<StartResult>> {
    switch (refusal.kind) {
      case 'precondition_failed': {
        // Reached only by someone with a basis to start: a start retried
        // after the community was locked answers with the running session.
        const running = await this.sessions.findLiveByCommunity(communityId);
        if (running !== null) return this.answer(principal, running, false);
        return err(LiveRefusals.communityNotOpen);
      }
      case 'forbidden':
        return err(LiveRefusals.startNotPermitted);
      default:
        return err(LiveRefusals.communityNotFound);
    }
  }

  /**
   * The session's view for the caller, with Communities asked afresh. Should
   * that fail after the session was stored, the answer is 503 — and the
   * session stands: a retry answers it with 200, as any repeated start does.
   */
  private async answer(
    principal: Principal,
    session: LiveSession,
    created: boolean,
  ): Promise<Result<StartResult>> {
    const view = await this.views.forCaller(principal, session);
    return view.ok ? ok({ created, session: view.value }) : view;
  }

  /** Best effort; an orphan is ended by the room sweep after its grace anyway. */
  private async endStrayRoom(room: string, session: LiveSession): Promise<void> {
    try {
      await this.rooms.endRoom(room);
    } catch (error) {
      if (!(error instanceof RtcUnavailableError)) {
        this.logger.error(
          {
            event: 'live.provider.error',
            sessionId: session.id,
            err: { name: error instanceof Error ? error.name : typeof error },
          },
          'could not end a room no session claims; left to the room sweep',
        );
      }
    }
  }
}

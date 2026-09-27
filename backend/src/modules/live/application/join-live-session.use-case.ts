import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  RATE_LIMITER,
  err,
  ok,
  type CallMetadata,
  type Principal,
  type RateLimiter,
  type Result,
} from '../../../shared';
import {
  ACCOUNT_DIRECTORY,
  AUTHORIZATION_SERVICE,
  Permissions,
  type AccountDirectory,
  type AuthorizationService,
} from '../../identity/contracts';
import type { LiveParticipantRole } from '../contracts/participant-role';
import {
  LiveRateLimits,
  MAX_JOIN_TOKEN_TTL_SECONDS,
  ROOM_PROVIDER_TIMEOUT_SECONDS,
  isJoinTokenTtl,
} from '../domain/live-limits';
import { currentMediaRoom, isLive, type LiveSession } from '../domain/live-session';
import { LIVE_SESSION_REPOSITORY, type LiveSessionRepository } from '../domain/ports';
import {
  RTC_ROOMS,
  RTC_TOKENS,
  RtcUnavailableError,
  type RtcAccessToken,
  type RtcRoomProvider,
  type RtcTokenIssuer,
} from '../domain/rtc-provider';
import { capabilitiesFor, roleOf } from '../domain/standing';
import { LiveAccess } from './live-access';
import {
  LIVE_SETTINGS,
  LiveRefusals,
  sessionUserKey,
  tooMany,
  type LiveSettings,
} from './live-settings';
import { LiveStanding } from './live-standing';
import { RoomOccupancy } from './room-occupancy';
import { mediaOf, type JoinTicket } from './views';

/**
 * Issues a join ticket (live.md S2) — the security boundary of live media.
 * The client never states what it may do or who it is: the server decides
 * both, here, and encodes them in the token.
 *
 *   1. identity's `live.join` (the route's gate, asked again), then the
 *      caller's limit in this session: 10 joins a minute, keyed by
 *      (session, user) — never by address, which a school shares;
 *   2. the session, by id → 404;
 *   3. Communities, on the session's OWN community id: `community.live.join`,
 *      or a moderator of the session → 404 like an unknown session, 412 for
 *      the lifecycle's refusal, 503 when Communities cannot answer;
 *   4. the session is live → else 412;
 *   5. the caller's standing: a moderator holding `live.speak` and a speaker
 *      holding a granted hand get the microphone; the presenter, the screen;
 *      everyone else is a listener and publishes nothing, not even data;
 *   6. the room, from a sample at most two seconds old: missing → ensured,
 *      then the session read again, and a session that ended meanwhile gets
 *      its room ended and 412 (ensure-then-recheck, §4.4) — one that a media
 *      reset moved meanwhile gets the re-created old room ended and is
 *      admitted to its current one, once; a listener over
 *      the soft cap → 412 live.session_full, moderators and speakers exempt;
 *      a provider outage skips both and fails open to the provider's hard
 *      cap;
 *   7. the name, from the account directory (never from the request);
 *   8. the token, for exactly the session's current media room, with its
 *      lifetime checked here first (audit D24) → 503 live.media_unavailable
 *      when the provider cannot sign, the disabled provider included.
 *
 * Nothing is written, audited or published: a join is transport. Calling it
 * again is always safe and always current — it is the way back in after a
 * disconnect, and it decides afresh every time.
 */
@Injectable()
export class JoinLiveSessionUseCase {
  private readonly logger = new Logger(JoinLiveSessionUseCase.name);

  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    private readonly access: LiveAccess,
    private readonly standing: LiveStanding,
    private readonly occupancy: RoomOccupancy,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(RTC_ROOMS) private readonly rooms: RtcRoomProvider,
    @Inject(RTC_TOKENS) private readonly tokens: RtcTokenIssuer,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(LIVE_SETTINGS) private readonly settings: LiveSettings,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sessionId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<JoinTicket>> {
    const { principal, sessionId } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.join);
    if (!allowed.ok) return allowed;

    const throttle = await this.limiter.consume(
      sessionUserKey(sessionId, principal.userId),
      LiveRateLimits.joinsPerSessionUser,
    );
    if (!throttle.allowed) return err(tooMany('live.too_many_joins', throttle.retryAfterSeconds));

    const session = await this.sessions.findById(sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    const participant = await this.access.participant(
      principal,
      session,
      LiveRefusals.sessionNotFound,
    );
    if (!participant.ok) return participant;
    if (!isLive(session)) return err(LiveRefusals.sessionNotLive);

    const { standing } = await this.standing.ofPrincipal(
      principal,
      session,
      participant.value.moderator !== null,
    );
    const role = roleOf(standing);
    const capabilities = capabilitiesFor(standing);

    const admitted = await this.admit(session, role);
    if (!admitted.ok) return admitted;
    // The room the session uses now — a media reset may have moved it.
    const room = admitted.value;

    const [account] = await this.directory.describe([principal.userId]);
    const ttlSeconds = this.settings.joinTokenTtlSeconds;
    // The provider's SDK reads a falsy lifetime as six hours: never ask it
    // for anything but a whole number of seconds, 1 to 600 (audit D24).
    if (!isJoinTokenTtl(ttlSeconds)) {
      throw new RangeError(
        `A join token lasts 1 to ${MAX_JOIN_TOKEN_TTL_SECONDS} whole seconds, not ${ttlSeconds}.`,
      );
    }
    let token: RtcAccessToken;
    try {
      token = await this.tokens.issueAccessToken({
        roomName: room,
        identity: principal.userId,
        displayName: account?.displayName ?? '',
        capabilities,
        ttlSeconds,
      });
    } catch (error) {
      if (error instanceof RtcUnavailableError) return err(LiveRefusals.mediaUnavailable);
      throw error;
    }
    if (role === 'listener') this.occupancy.listenerAdmitted(room);

    return ok({
      token: token.token,
      url: token.url,
      expiresInSeconds: token.expiresInSeconds,
      role,
      media: mediaOf(capabilities),
    });
  }

  /**
   * Step 6: the room exists, and a listener fits under the soft cap — or the
   * provider cannot say. Answers the room the token is for: the session's
   * current one.
   *
   * The re-read after ensuring a missing room compares the media room epoch
   * as well as the state. A media reset (§11.4) that committed meanwhile
   * moved the session to a new room and deleted the old one — which this
   * call has just re-created: it is nobody's, so it is ended, and the join is
   * admitted again against the room the session uses now. Once: if the
   * session moves again meanwhile, the answer is 503 live.media_unavailable,
   * which the client retries.
   */
  private async admit(
    session: LiveSession,
    role: LiveParticipantRole,
    moved = false,
  ): Promise<Result<string>> {
    const room = currentMediaRoom(this.settings.roomNamePrefix, session);
    const sample = await this.occupancy.sample(room);
    if (sample.kind === 'unavailable') return ok(room);
    if (sample.kind === 'missing') {
      try {
        await this.rooms.ensureRoom({
          roomName: room,
          maxParticipants: session.participantCap + session.moderatorReserve,
          emptyTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
          departureTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
        });
      } catch (error) {
        if (error instanceof RtcUnavailableError) return ok(room);
        throw error;
      }
      // Without this read, a join racing End — or a media reset — would
      // bring a deleted room back.
      const now = await this.sessions.findById(session.id);
      if (now === null || !isLive(now)) {
        await this.endRoom(room, session);
        return err(LiveRefusals.sessionNotLive);
      }
      if (now.mediaRoomEpoch !== session.mediaRoomEpoch) {
        await this.endRoom(room, session);
        return moved ? err(LiveRefusals.mediaUnavailable) : this.admit(now, role, true);
      }
      this.occupancy.ensured(room);
      return ok(room);
    }
    // Moderators and current speakers skip the soft cap: the reserve is
    // theirs, so a teacher who drops out always gets back in.
    if (role === 'listener' && sample.occupancy >= session.participantCap) {
      return err(LiveRefusals.sessionFull);
    }
    return ok(room);
  }

  private async endRoom(room: string, session: LiveSession): Promise<void> {
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
          'could not end a room the session no longer uses; left to the room sweep',
        );
      }
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Result } from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  Permissions,
  type AuthorizationService,
  type Principal,
} from '../../identity/contracts';
import { isJoinable } from '../domain/live-room';
import {
  LIVE_ROOM_REPOSITORY,
  LIVE_SESSION_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
  type LiveRoomRepository,
  type LiveSessionRepository,
  type SpeakerRequestRepository,
} from '../domain/ports';
import {
  LISTENER,
  RTC_PROVIDER,
  SPEAKER,
  type RtcAccessToken,
  type RtcProvider,
} from '../domain/rtc-provider';
import { currentSpeakers } from '../domain/speaker-request';

/** Join tokens are short-lived; the client reconnects rather than holding one. */
export const JOIN_TOKEN_TTL_SECONDS = 600;

export interface JoinLiveSessionCommand {
  readonly principal: Principal;
  readonly sessionId: string;
  readonly displayName: string;
}

/**
 * Issues a join token for a live session.
 *
 * This is the security boundary of the whole realtime feature. The client never
 * states what it may do — the server decides here and encodes it in the token:
 *
 *   host                     -> may publish audio
 *   participant with a grant -> may publish audio (survives a reconnect)
 *   everyone else            -> listener, cannot publish
 *
 * Because listeners are issued non-publishing tokens, a 2500-person room costs
 * the SFU one upstream audio track, not 2500.
 */
@Injectable()
export class JoinLiveSessionUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(LIVE_ROOM_REPOSITORY) private readonly rooms: LiveRoomRepository,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
    @Inject(RTC_PROVIDER) private readonly rtc: RtcProvider,
  ) {}

  async execute(command: JoinLiveSessionCommand): Promise<Result<RtcAccessToken>> {
    const allowed = this.authorization.authorize(command.principal, Permissions.live.join);
    if (!allowed.ok) return allowed;

    const session = await this.sessions.findById(command.sessionId as never);
    if (session === null) {
      return err(failure('not_found', 'live.session_not_found', 'No such live session.'));
    }
    if (!isJoinable(session)) {
      return err(
        failure(
          'precondition_failed',
          'live.session_not_live',
          'This session is not currently live.',
        ),
      );
    }

    const room = await this.rooms.findById(session.roomId);
    if (room === null) {
      return err(failure('not_found', 'live.room_not_found', 'No such live room.'));
    }

    // The host publishes by virtue of running the room AND holding live.speak;
    // anyone else publishes only while holding a per-session grant.
    const isHost =
      room.hostUserId === command.principal.userId &&
      this.authorization.can(command.principal, Permissions.live.speak, {
        resourceType: 'live.session',
        resourceId: session.id,
        ownerUserId: room.hostUserId,
      });
    const holdsGrant = currentSpeakers(await this.requests.findBySession(session.id)).some(
      (request) => request.userId === command.principal.userId,
    );

    const token = await this.rtc.issueAccessToken({
      roomName: session.id,
      identity: command.principal.userId,
      displayName: command.displayName,
      capabilities: isHost || holdsGrant ? SPEAKER : LISTENER,
      ttlSeconds: JOIN_TOKEN_TTL_SECONDS,
    });

    return ok(token);
  }
}

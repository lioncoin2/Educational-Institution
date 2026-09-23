import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Result } from '../../../shared';
import {
  ACCOUNT_DIRECTORY,
  AUTHORIZATION_SERVICE,
  Permissions,
  type AccountDirectory,
  type AuthorizationService,
  type Principal,
} from '../../identity/contracts';
import { isJoinable, type LiveSessionId } from '../domain/live-room';
import {
  LIVE_ROOM_REPOSITORY,
  LIVE_SESSION_REPOSITORY,
  type LiveRoomRepository,
  type LiveSessionRepository,
} from '../domain/ports';
import { RTC_TOKENS, type RtcTokenIssuer } from '../domain/rtc-provider';
import { capabilitiesFor } from '../domain/standing';
import { LiveStanding } from './live-standing';
import { mediaOf, type JoinTicket } from './views';

/**
 * How long a join token is good for — to START a connection.
 *
 * Short on purpose (approved: 120 s): a token that leaks is only good for a
 * fresh connection within two minutes. It does not limit how long anyone
 * stays: once connected, the media server itself sends the client a fresh
 * token straight away and every five minutes after, each valid ten minutes
 * and carrying the participant's current permissions, and the client SDK
 * reconnects with the newest one (verified in LiveKit's server and Flutter
 * SDK source, docs/architecture/live.md §9). Token expiry never disconnects
 * a connected participant. A client that could not connect within 120 s, or
 * was away longer than its refreshed token lasts, simply calls `/join` again.
 */
export const JOIN_TOKEN_TTL_SECONDS = 120;

export interface JoinLiveSessionCommand {
  readonly principal: Principal;
  readonly sessionId: string;
}

/**
 * Issues a join ticket for a live session — the security boundary of live
 * media. The client never states what it may do or who it is: the server
 * decides both here and encodes them in the token.
 *
 *   the host who may speak   -> moderator: may publish audio
 *   a person holding a grant -> speaker: may publish audio (survives a reconnect)
 *   everyone else            -> listener: subscribes only, no data channel
 *
 * Every call decides afresh from the current records, so calling it again is
 * always safe and always current. The name in the token comes from the
 * account directory, never from the request.
 */
@Injectable()
export class JoinLiveSessionUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(LIVE_ROOM_REPOSITORY) private readonly rooms: LiveRoomRepository,
    @Inject(RTC_TOKENS) private readonly tokens: RtcTokenIssuer,
    private readonly standing: LiveStanding,
  ) {}

  async execute(command: JoinLiveSessionCommand): Promise<Result<JoinTicket>> {
    const allowed = this.authorization.authorize(command.principal, Permissions.live.join);
    if (!allowed.ok) return allowed;

    const session = await this.sessions.findById(command.sessionId as LiveSessionId);
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

    const role = await this.standing.ofPrincipal(command.principal, session, room);
    const capabilities = capabilitiesFor(role);
    const [account] = await this.directory.describe([command.principal.userId]);

    const token = await this.tokens.issueAccessToken({
      roomName: session.id,
      identity: command.principal.userId,
      displayName: account?.displayName ?? '',
      capabilities,
      ttlSeconds: JOIN_TOKEN_TTL_SECONDS,
    });

    return ok({
      token: token.token,
      url: token.url,
      expiresInSeconds: token.expiresInSeconds,
      role,
      media: mediaOf(capabilities),
    });
  }
}

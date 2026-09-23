import { Inject, Injectable } from '@nestjs/common';

import {
  ACCOUNT_DIRECTORY,
  AUTHORIZATION_SERVICE,
  Permissions,
  type AccountDirectory,
  type AuthorizationService,
  type Principal,
} from '../../identity/contracts';
import type { LiveParticipantRole } from '../contracts/participant-role';
import {
  isJoinable,
  type LiveRoom,
  type LiveSession,
  type LiveSessionId,
} from '../domain/live-room';
import {
  LIVE_ROOM_REPOSITORY,
  LIVE_SESSION_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
  type LiveRoomRepository,
  type LiveSessionRepository,
  type SpeakerRequestRepository,
} from '../domain/ports';
import { roleOf } from '../domain/standing';

/**
 * Where a person stands in a live session right now — decided from live's own
 * records and identity's answer, recomputed every time it is asked. Join and
 * the convergence watch ask the same question the same way, so a token and a
 * re-applied permission set can never disagree about who may publish.
 *
 * The host publishes by running the room AND holding `live.speak` (the host
 * rule is identity's, Q1); anyone else publishes only while holding a granted
 * hand in this session.
 */
@Injectable()
export class LiveStanding {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(LIVE_ROOM_REPOSITORY) private readonly rooms: LiveRoomRepository,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
  ) {}

  /** A signed-in caller's role — the join path. */
  async ofPrincipal(
    principal: Principal,
    session: LiveSession,
    room: LiveRoom,
  ): Promise<LiveParticipantRole> {
    const hostMaySpeak =
      room.hostUserId === principal.userId &&
      this.authorization.can(principal, Permissions.live.speak, {
        resourceType: 'live.session',
        resourceId: session.id,
        ownerUserId: room.hostUserId,
      });
    return roleOf({
      hostMaySpeak,
      holdsGrant: await this.holdsGrant(session.id, principal.userId),
    });
  }

  /**
   * An account's role without a request — the convergence watch. Null when
   * the session is gone or no longer live: there is nothing left to apply.
   * Identity answers whether the account (ACTIVE) may speak at all, exactly
   * as it would for the signed-in account.
   */
  async ofAccount(sessionId: string, userId: string): Promise<LiveParticipantRole | null> {
    const session = await this.sessions.findById(sessionId as LiveSessionId);
    if (session === null || !isJoinable(session)) return null;
    const room = await this.rooms.findById(session.roomId);
    if (room === null) return null;
    const hostMaySpeak =
      room.hostUserId === userId &&
      (await this.directory.withPermission([userId], Permissions.live.speak)).has(userId);
    return roleOf({ hostMaySpeak, holdsGrant: await this.holdsGrant(sessionId, userId) });
  }

  private async holdsGrant(sessionId: string, userId: string): Promise<boolean> {
    return (await this.requests.findOpen(sessionId, userId))?.state === 'granted';
  }
}

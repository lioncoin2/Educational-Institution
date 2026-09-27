import { Inject, Injectable } from '@nestjs/common';

import type { LiveSessionScope, LiveSessions } from '../contracts/live-sessions';
import { isLive } from '../domain/live-session';
import { LIVE_SESSION_REPOSITORY, type LiveSessionRepository } from '../domain/ports';

/**
 * LIVE_SESSIONS (live.md §13) — a session's scope from Live's own record:
 * one read of the session row. Never the media provider, and no principal:
 * whoever asks authorizes its own act against the community named here.
 */
@Injectable()
export class LiveSessionsReader implements LiveSessions {
  constructor(@Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository) {}

  async describe(liveSessionId: string): Promise<LiveSessionScope | null> {
    const session = await this.sessions.findById(liveSessionId);
    if (session === null) return null;
    return {
      liveSessionId: session.id,
      communityId: session.communityId,
      hostUserId: session.hostUserId,
      active: isLive(session),
    };
  }
}

import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared';
import type { SessionReference } from '../contracts/access-tokens';
import { ACTIVE_SESSIONS_MAX_BATCH, type ActiveSessions } from '../contracts/active-sessions';
import type { AuthSessionId } from '../domain/auth-session';
import { AUTH_SESSION_REPOSITORY, type AuthSessionRepository } from '../domain/ports';

/**
 * Identity's implementation of the live-session question other modules ask
 * (ADR 0058). One lookup by id, judged against identity's own clock: a session
 * counts only while it is unrevoked, unexpired, and owned by the account the
 * caller named with it.
 */
@Injectable()
export class IdentityActiveSessions implements ActiveSessions {
  constructor(
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async activeAmong(refs: readonly SessionReference[]): Promise<readonly SessionReference[]> {
    if (refs.length > ACTIVE_SESSIONS_MAX_BATCH) {
      throw new RangeError(`at most ${ACTIVE_SESSIONS_MAX_BATCH} session references`);
    }
    if (refs.length === 0) return [];
    const live = await this.sessions.findActiveByIds(
      [...new Set(refs.map((ref) => ref.sessionId as AuthSessionId))],
      this.clock.now(),
    );
    const owners = new Map<string, string>(live.map((session) => [session.id, session.userId]));
    return refs.filter((ref) => owners.get(ref.sessionId) === ref.userId);
  }
}

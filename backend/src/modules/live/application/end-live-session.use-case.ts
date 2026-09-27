import { Inject, Injectable } from '@nestjs/common';

import { err, type CallMetadata, type Principal, type Result } from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  Permissions,
  type AuthorizationService,
} from '../../identity/contracts';
import { LIVE_SESSION_REPOSITORY, type LiveSessionRepository } from '../domain/ports';
import { LiveAccess } from './live-access';
import { LiveSessionLifecycle } from './live-session-lifecycle';
import { LiveRefusals, isLiveId } from './live-settings';
import { LiveSessionViews } from './session-views';
import type { LiveSessionView } from './views';

/**
 * A moderator ends the session (live.md §4.2, S5). Any of the session's
 * moderators may — the host, the owner, a delegate holding
 * `community.live.moderate` (audit D2): End has no target, so
 * `live.target_is_host` does not apply.
 *
 * Idempotent: a session already ended answers 200 with its view and nothing
 * else happens. Otherwise `LiveSessionLifecycle` ends it: one step, one audit
 * entry with the permit the moderator acted on, one `live.session.ended`,
 * then the media room, best effort.
 */
@Injectable()
export class EndLiveSessionUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    private readonly lifecycle: LiveSessionLifecycle,
    private readonly views: LiveSessionViews,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sessionId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<LiveSessionView>> {
    const { principal } = command;
    // The coarse check, before anything is read: a caller who may not
    // moderate at all learns nothing about which sessions exist.
    const allowed = this.identity.authorize(principal, Permissions.live.moderate);
    if (!allowed.ok) return allowed;
    if (!isLiveId(command.sessionId)) return err(LiveRefusals.sessionNotFound);

    const session = await this.sessions.findById(command.sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    const permit = await this.access.moderator(principal, session, LiveRefusals.sessionNotFound);
    if (!permit.ok) return permit;

    const outcome = await this.lifecycle.end({
      sessionId: session.id,
      endedBy: principal.userId,
      reason: 'moderator',
      permit: permit.value,
      correlationId: command.meta.correlationId,
    });
    if (outcome === null) return err(LiveRefusals.sessionNotFound);
    return this.views.forCaller(principal, outcome.session);
  }
}

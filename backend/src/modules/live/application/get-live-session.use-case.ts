import { Inject, Injectable } from '@nestjs/common';

import { err, type Principal, type Result } from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  Permissions,
  type AuthorizationService,
} from '../../identity/contracts';
import { LIVE_SESSION_REPOSITORY, type LiveSessionRepository } from '../domain/ports';
import { LiveAccess } from './live-access';
import { LiveRefusals, isLiveId } from './live-settings';
import { LiveSessionViews } from './session-views';
import type { LiveSessionView } from './views';

/**
 * One session, as the caller sees it (live.md §15.1). Visible to whoever
 * Communities lets join it — a member refused only by the lifecycle still
 * sees it, with `me.canJoin` false — and to its moderators. Anyone else is
 * told exactly what they would be told about a session that does not exist.
 */
@Injectable()
export class GetLiveSessionUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    private readonly views: LiveSessionViews,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sessionId: string;
  }): Promise<Result<LiveSessionView>> {
    const { principal } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.join);
    if (!allowed.ok) return allowed;
    if (!isLiveId(command.sessionId)) return err(LiveRefusals.sessionNotFound);

    const session = await this.sessions.findById(command.sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    const viewer = await this.access.viewer(principal, session, LiveRefusals.sessionNotFound);
    if (!viewer.ok) return viewer;
    return this.views.of(principal, session, viewer.value);
  }
}

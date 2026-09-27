import { Inject, Injectable } from '@nestjs/common';

import { ok, type Principal, type Result } from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  Permissions,
  type AuthorizationService,
} from '../../identity/contracts';
import { LIVE_SESSION_REPOSITORY, type LiveSessionRepository } from '../domain/ports';
import { LiveAccess } from './live-access';
import { LiveRefusals } from './live-settings';
import { LiveSessionViews } from './session-views';
import type { CurrentSessionResult } from './views';

/**
 * "Live now" for a community (live.md §15.1): its running session, or null.
 * A client composes the community screen's live banner from it, so Live
 * never needs a route in Communities' URL space.
 *
 * Asked like a session view — `community.live.join`, a lifecycle refusal
 * included, or a moderator — and refused with one 404 whether the community
 * is unknown or the caller may not see it: a non-member never learns whether
 * a session runs.
 */
@Injectable()
export class GetCurrentLiveSessionUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    private readonly views: LiveSessionViews,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
  }): Promise<Result<CurrentSessionResult>> {
    const { principal, communityId } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.join);
    if (!allowed.ok) return allowed;

    const session = await this.sessions.findLiveByCommunity(communityId);
    const viewer = await this.access.viewer(
      principal,
      { communityId, hostUserId: session?.hostUserId ?? null },
      LiveRefusals.communityNotFound,
    );
    if (!viewer.ok) return viewer;
    if (session === null) return ok({ session: null });
    const view = await this.views.of(principal, session, viewer.value);
    return view.ok ? ok({ session: view.value }) : view;
  }
}

import { Inject, Injectable } from '@nestjs/common';

import { ok, type Principal, type Result } from '../../../shared';
import { PENDING_HANDS_COUNT_CAP } from '../domain/live-limits';
import { isLive, type LiveSession } from '../domain/live-session';
import { SPEAKER_REQUEST_REPOSITORY, type SpeakerRequestRepository } from '../domain/ports';
import { roleOf } from '../domain/standing';
import { LiveAccess, isOutage, takesPart, type Participation } from './live-access';
import { LiveStanding } from './live-standing';
import { liveSessionView, type LiveSessionView } from './views';

/**
 * Builds a session's view for one caller (live.md §15.3). Its `me` flags come
 * from the same answers the commands ask for — Communities' permits,
 * identity's `live.speak`, the caller's own hand and the presenter slot — so
 * a button is shown exactly when its command would be allowed now. They are
 * hints: every command asks again.
 *
 * The reads are bounded whatever the session's size: point reads, the
 * granted hands (at most MAX_CONCURRENT_SPEAKERS), and for a moderator a
 * pending count that stops at PENDING_HANDS_COUNT_CAP.
 */
@Injectable()
export class LiveSessionViews {
  constructor(
    private readonly access: LiveAccess,
    private readonly standing: LiveStanding,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
  ) {}

  /**
   * The session as the caller sees it now, with Communities asked afresh —
   * the answer after a command. Never refused: someone who can no longer see
   * the session (a presenter removed from the community, stopping their own
   * share) gets the view with every flag off. Only an outage fails (503).
   */
  async forCaller(principal: Principal, session: LiveSession): Promise<Result<LiveSessionView>> {
    const participation = await this.access.participation(principal, session);
    if (!participation.ok) return participation;
    return this.of(principal, session, participation.value);
  }

  /** The view, from answers the caller's request has already asked for. */
  async of(
    principal: Principal,
    session: LiveSession,
    participation: Participation,
  ): Promise<Result<LiveSessionView>> {
    const moderator = participation.moderator !== null;
    const live = isLive(session);
    const { standing, hand, presenter } = await this.standing.ofPrincipal(
      principal,
      session,
      moderator,
    );
    let canRaiseHand = false;
    if (live) {
      const raise = await this.access.ask(
        principal,
        session.communityId,
        'community.live.raise_hand',
      );
      if (isOutage(raise)) return raise;
      canRaiseHand = raise.ok;
    }
    const speakerCount = (await this.requests.granted(session.id)).length;
    const pendingHands = moderator
      ? await this.requests.countPending(session.id, PENDING_HANDS_COUNT_CAP)
      : null;
    const slotFree = presenter === null || presenter.userId === principal.userId;

    return ok(
      liveSessionView(session, {
        speakerCount,
        presenterUserId: presenter?.userId ?? null,
        pendingHands,
        me: {
          role: roleOf(standing),
          isHost: principal.userId === session.hostUserId,
          canJoin: live && takesPart(participation),
          canRaiseHand,
          canModerate: live && moderator,
          canEnd: live && moderator,
          canPresent: live && standing.publishesByRight && slotFree,
          presenting: standing.presenter,
          hand: hand === null ? null : { requestId: hand.id, state: hand.state },
        },
      }),
    );
  }
}

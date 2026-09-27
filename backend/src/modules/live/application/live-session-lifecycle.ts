import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '../../../shared';
import type { CommunityPermit } from '../../communities/contracts/authorization';
import { liveSessionEnded } from '../domain/events';
import {
  currentMediaRoom,
  type LiveSession,
  type LiveSessionEndReason,
} from '../domain/live-session';
import type { ModerationAction } from '../domain/moderation';
import {
  LIVE_SESSION_REPOSITORY,
  type EndOutcome,
  type LiveSessionRepository,
} from '../domain/ports';
import { RTC_ROOMS, RtcUnavailableError, type RtcRoomProvider } from '../domain/rtc-provider';
import { permitOf } from './live-access';
import { LiveJournal, moderationAudit } from './live-journal';
import { LiveMedia } from './live-media';
import { LIVE_SETTINGS, type LiveSettings } from './live-settings';

/**
 * Ending a session (live.md §4.2) — a moderator's End and the system's
 * (`endBySystem`: the reconciler's idle end, or a community that no longer
 * lets a running session continue) go through this one path.
 *
 * The repository ends it in one step under the session's lock: `ended`,
 * every open hand expired, the presenter grant closed, the `end_session`
 * row. Then, only if that step changed the session:
 *
 *   1. the audit entry — its actor null when the system ended it;
 *   2. ONE `live.session.ended`, which implies every expiry and the
 *      presenter's close: no per-hand event;
 *   3. `endRoom`, best effort — a room already gone is success, and an
 *      outage is left to the room sweep, which ends any room of this
 *      deployment's form that no live session claims.
 *
 * `ended` is stored before the provider is called, so a presence reading
 * racing the end re-reads `ended` (attendance's requirement). A session that
 * had already ended is answered as it is: no audit, no event, no provider
 * call.
 */
@Injectable()
export class LiveSessionLifecycle {
  private readonly logger = new Logger(LiveSessionLifecycle.name);

  constructor(
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(RTC_ROOMS) private readonly rooms: RtcRoomProvider,
    @Inject(LIVE_SETTINGS) private readonly settings: LiveSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly media: LiveMedia,
    private readonly journal: LiveJournal,
  ) {}

  /**
   * Ends the session. `endedBy` is the moderator, with the permit they acted
   * on; null for the system. Null for an unknown session.
   */
  async end(input: {
    readonly sessionId: string;
    readonly endedBy: string | null;
    readonly reason: LiveSessionEndReason;
    readonly permit: CommunityPermit | null;
    readonly correlationId?: string;
  }): Promise<EndOutcome | null> {
    const at = this.clock.now();
    const moderation: ModerationAction = {
      id: this.ids.next<'ModerationAction'>(),
      sessionId: input.sessionId,
      actorUserId: input.endedBy,
      targetUserId: null,
      type: 'end_session',
      at,
    };
    const outcome = await this.sessions.end({
      sessionId: input.sessionId,
      at,
      endedBy: input.endedBy,
      reason: input.reason,
      moderation,
    });
    if (outcome === null || !outcome.ended) return outcome;

    const ended = outcome.session;
    await this.journal.record(
      moderationAudit(moderation, {
        communityId: ended.communityId,
        detail: {
          reason: input.reason,
          ...(input.permit === null ? {} : { permit: permitOf(input.permit) }),
        },
        correlationId: input.correlationId,
      }),
      [liveSessionEnded(ended, input.correlationId)],
    );
    this.media.forget(ended.id);
    await this.endRoom(ended);
    return outcome;
  }

  /** The system's end, with no actor: `idle` (Q61) or `community_closed` (Q47). */
  endBySystem(
    sessionId: string,
    reason: Exclude<LiveSessionEndReason, 'moderator'>,
  ): Promise<EndOutcome | null> {
    return this.end({ sessionId, endedBy: null, reason, permit: null });
  }

  private async endRoom(session: LiveSession): Promise<void> {
    try {
      await this.rooms.endRoom(currentMediaRoom(this.settings.roomNamePrefix, session));
    } catch (error) {
      // Best effort: the room sweep ends any room no live session claims. An
      // outage was logged by the adapter already; anything else is a fault.
      if (!(error instanceof RtcUnavailableError)) {
        this.logger.error(
          {
            event: 'live.provider.error',
            sessionId: session.id,
            err: { name: error instanceof Error ? error.name : typeof error },
          },
          'could not end an ended session’s media room; left to the room sweep',
        );
      }
    }
  }
}

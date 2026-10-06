import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  err,
  ok,
  type CallMetadata,
  type Clock,
  type IdGenerator,
  type Principal,
  type Result,
} from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  Permissions,
  type AuthorizationService,
} from '../../identity/contracts';
import { participantRemoved } from '../domain/events';
import { currentMediaRoom, isLive } from '../domain/live-session';
import type { ModerationAction } from '../domain/moderation';
import { LIVE_SESSION_REPOSITORY, type LiveSessionRepository } from '../domain/ports';
import {
  RTC_PARTICIPANTS,
  type RtcApplyOutcome,
  type RtcParticipantControl,
} from '../domain/rtc-provider';
import { LiveAccess, permitOf } from './live-access';
import { LiveJournal, moderationAudit } from './live-journal';
import {
  LIVE_SETTINGS,
  LiveRefusals,
  isLiveId,
  isReasonCode,
  mediaRefusal,
  type LiveSettings,
} from './live-settings';
import type { KickParticipantResult } from './views';

export interface KickParticipantCommand {
  readonly principal: Principal;
  readonly sessionId: string;
  readonly targetUserId: string;
  /** An optional moderation reason CODE (never free text); omitted when none is given. */
  readonly reason?: string;
  readonly meta: CallMetadata;
}

/**
 * A moderator removes a participant from a live session (Q64, ADR 0026): an
 * administrative disconnect, NOT a ban.
 *
 *   1. identity's coarse `live.moderate`, before anything is read;
 *   2. the ids — a malformed session or target is answered as unknown, before
 *      any store, Communities or provider call;
 *   3. an optional reason CODE, validated (never free text);
 *   4. the session → 404 live.session_not_found, 412 live.session_not_live
 *      after the end;
 *   5. `LiveAccess.moderator` on the session's own community → 404, 403
 *      live.not_a_moderator, 503;
 *   6. the host, acted on by anyone but the host → 403 live.target_is_host;
 *   7. the media plane: `RtcParticipantControl.removeParticipant` on the
 *      session's current room. `applied` → removed; `not_connected` → the
 *      person was not in the room (a no-op: nothing audited, nothing told); a
 *      provider outage or misconfiguration → 503, never a false success;
 *   8. on `applied` only: the journal — the `remove_participant` audit action
 *      with the permit, the target and the reason — and the
 *      `live.participant.removed` fact, which the realtime relay delivers to
 *      the removed person.
 *
 * The person may re-enter at once through `/join`: no ban, no denylist, no
 * state kept. On the open-source media server a removal does not revoke an
 * already-issued token, so removal is never the only enforcement (live.md §9);
 * a reset (`ResetRoomUseCase`) is what invalidates every current credential.
 */
@Injectable()
export class KickParticipantUseCase {
  private readonly logger = new Logger(KickParticipantUseCase.name);

  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(RTC_PARTICIPANTS) private readonly participants: RtcParticipantControl,
    @Inject(LIVE_SETTINGS) private readonly settings: LiveSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly journal: LiveJournal,
  ) {}

  async execute(command: KickParticipantCommand): Promise<Result<KickParticipantResult>> {
    const { principal, sessionId, targetUserId, reason, meta } = command;

    const allowed = this.identity.authorize(principal, Permissions.live.moderate);
    if (!allowed.ok) return allowed;
    if (!isLiveId(sessionId)) return err(LiveRefusals.sessionNotFound);
    if (!isLiveId(targetUserId)) return err(LiveRefusals.targetNotInSession);
    if (reason !== undefined && !isReasonCode(reason)) return err(LiveRefusals.reasonInvalid);

    const session = await this.sessions.findById(sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    if (!isLive(session)) return err(LiveRefusals.sessionNotLive);

    const permit = await this.access.moderator(principal, session, LiveRefusals.sessionNotFound);
    if (!permit.ok) return permit;
    if (targetUserId === session.hostUserId && principal.userId !== session.hostUserId) {
      return err(LiveRefusals.targetIsHost);
    }

    const now = this.clock.now();
    const room = currentMediaRoom(this.settings.roomNamePrefix, session);
    let outcome: RtcApplyOutcome;
    try {
      outcome = await this.participants.removeParticipant(room, targetUserId, {
        revokeTokensIssuedBefore: now,
      });
    } catch (error) {
      const refusal = mediaRefusal(error);
      if (refusal !== null) return err(refusal);
      throw error;
    }

    // Not in the room: nothing changed — nothing audited, nothing told (D6).
    if (outcome === 'not_connected') return ok({ removed: false });

    const action: ModerationAction = {
      id: this.ids.next<'ModerationAction'>(),
      sessionId: session.id,
      actorUserId: principal.userId,
      targetUserId,
      type: 'remove_participant',
      at: now,
      ...(reason === undefined ? {} : { reasonCode: reason }),
    };
    await this.journal.record(
      moderationAudit(action, {
        communityId: session.communityId,
        detail: { permit: permitOf(permit.value), reason: reason ?? null },
        correlationId: meta.correlationId,
      }),
      [
        participantRemoved(
          session,
          targetUserId,
          principal.userId,
          reason ?? null,
          now,
          meta.correlationId,
        ),
      ],
    );
    this.logger.log(
      {
        event: 'live.participant.removed',
        sessionId: session.id,
        userId: targetUserId,
        by: principal.userId,
      },
      'a moderator removed a participant from the live session',
    );
    return ok({ removed: true });
  }
}

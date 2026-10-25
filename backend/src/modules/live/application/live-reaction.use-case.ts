import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  RATE_LIMITER,
  err,
  ok,
  type CallMetadata,
  type Clock,
  type IdGenerator,
  type Principal,
  type RateLimiter,
  type Result,
} from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  Permissions,
  type AuthorizationService,
} from '../../identity/contracts';
import { liveReactionSent } from '../domain/events';
import { LiveRateLimits } from '../domain/live-limits';
import { liveReactionKind, type LiveReactionKind } from '../domain/live-reaction';
import { isLive } from '../domain/live-session';
import { LIVE_SESSION_REPOSITORY, type LiveSessionRepository } from '../domain/ports';
import { LiveAccess } from './live-access';
import { LiveJournal } from './live-journal';
import { LiveRefusals, isLiveId, sessionUserKey, tooMany } from './live-settings';

export interface LiveReactionResult {
  readonly reactionId: string;
  readonly kind: LiveReactionKind;
}

/**
 * A participant reacts in a running session (C15, ADR 0049) — one of the
 * room's four reactions, delivered to the session's other participants as it
 * happens and kept nowhere.
 *
 *   1. identity's `live.join` (the route's gate, asked again); a malformed
 *      session id → 404, uncounted; then the caller's limit in this session:
 *      30 a minute, per (session, user) → 429 live.too_many_reactions;
 *   2. the kind is one of the four → else 422 live.reaction_invalid;
 *   3. the session → 404; the caller takes part in it (`community.live.join`,
 *      or a moderator — `LiveAccess.participant`) → else the same 404 an
 *      unknown session is, 412 for the lifecycle's refusal, 503 when
 *      Communities cannot answer;
 *   4. the session is live → else 412 live.session_not_live;
 *   5. the `live.reaction.sent` fact, published through the journal with no
 *      audit entry — a person's own gesture, like a raised hand.
 *
 * Nothing is stored, so nothing is idempotent to keep: a retry is another
 * reaction. The realtime relay re-asks who may receive it, at delivery.
 */
@Injectable()
export class SendLiveReactionUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly journal: LiveJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sessionId: string;
    readonly kind: unknown;
    readonly meta: CallMetadata;
  }): Promise<Result<LiveReactionResult>> {
    const { principal, sessionId } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.join);
    if (!allowed.ok) return allowed;
    // Before the limiter: its key holds the id (`isLiveId`).
    if (!isLiveId(sessionId)) return err(LiveRefusals.sessionNotFound);
    const throttle = await this.limiter.consume(
      sessionUserKey(sessionId, principal.userId),
      LiveRateLimits.reactionsPerSessionUser,
    );
    if (!throttle.allowed) {
      return err(tooMany('live.too_many_reactions', throttle.retryAfterSeconds));
    }
    const kind = liveReactionKind(command.kind);
    if (!kind.ok) return kind;

    const session = await this.sessions.findById(sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    const participation = await this.access.participant(
      principal,
      session,
      LiveRefusals.sessionNotFound,
    );
    if (!participation.ok) return participation;
    if (!isLive(session)) return err(LiveRefusals.sessionNotLive);

    const reactionId = this.ids.next<'LiveReaction'>();
    await this.journal.record(null, [
      liveReactionSent(
        session,
        { id: reactionId, kind: kind.value, sentBy: principal.userId, at: this.clock.now() },
        command.meta.correlationId,
      ),
    ]);
    return ok({ reactionId, kind: kind.value });
  }
}

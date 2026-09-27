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
import { speakerRequested } from '../domain/events';
import { LiveRateLimits } from '../domain/live-limits';
import { isLive } from '../domain/live-session';
import {
  LIVE_SESSION_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
  type LiveSessionRepository,
  type SpeakerRequestRepository,
} from '../domain/ports';
import { newSpeakerRequest } from '../domain/speaker-request';
import { LiveAccess, isOutage } from './live-access';
import { LiveJournal } from './live-journal';
import { LiveRefusals, sessionUserKey, tooMany } from './live-settings';
import { speakerRequestView, type RaiseHandResult } from './views';

/**
 * A participant raises their hand (live.md §5, S3). Idempotent: a hand
 * already up — pending or granted — is answered as it is (200), with no
 * second row and no second event, so a double tap or a retry is harmless;
 * twenty simultaneous raises make one request.
 *
 *   1. identity's `live.raise_hand` (the route's gate, asked again), then
 *      the caller's limit in this session: 6 a minute, per (session, user);
 *   2. the session → 404;
 *   3. `community.live.raise_hand`, on the session's own community → 404
 *      like an unknown session, 412 for the lifecycle's refusal, 503 when
 *      Communities cannot answer;
 *   4. the session is live → else 412;
 *   5. an open hand → 200 with it, read without the session's lock;
 *   6. otherwise the insert: a new hand → `live.speaker.requested`, 201.
 *
 * A raised hand is application state, never media state: nothing here
 * touches the provider, and the person stays a listener until a moderator
 * grants the floor — which is what keeps the queue cheap in a large session.
 * Not audited: it is the person's own act.
 */
@Injectable()
export class RaiseHandUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly journal: LiveJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sessionId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<RaiseHandResult>> {
    const { principal, sessionId } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.raiseHand);
    if (!allowed.ok) return allowed;

    const throttle = await this.limiter.consume(
      sessionUserKey(sessionId, principal.userId),
      LiveRateLimits.handsPerSessionUser,
    );
    if (!throttle.allowed) return err(tooMany('live.too_many_hands', throttle.retryAfterSeconds));

    const session = await this.sessions.findById(sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    const permit = await this.access.ask(
      principal,
      session.communityId,
      'community.live.raise_hand',
    );
    if (isOutage(permit)) return permit;
    if (!permit.ok) {
      return err(
        permit.error.kind === 'precondition_failed'
          ? LiveRefusals.communityNotOpen
          : LiveRefusals.sessionNotFound,
      );
    }
    if (!isLive(session)) return err(LiveRefusals.sessionNotLive);

    // The fast path: a hand already up is answered without the session's lock.
    const open = await this.requests.findOpen(session.id, principal.userId);
    if (open !== null) return ok({ created: false, request: speakerRequestView(open) });

    const outcome = await this.requests.raise(
      newSpeakerRequest({
        id: this.ids.next<'SpeakerRequest'>(),
        sessionId: session.id,
        userId: principal.userId,
        at: this.clock.now(),
      }),
    );
    if (outcome === 'session_not_live') return err(LiveRefusals.sessionNotLive);
    if (outcome.created) {
      await this.journal.record(null, [
        speakerRequested(
          session,
          outcome.request,
          outcome.stateVersion,
          command.meta.correlationId,
        ),
      ]);
    }
    return ok({ created: outcome.created, request: speakerRequestView(outcome.request) });
  }
}

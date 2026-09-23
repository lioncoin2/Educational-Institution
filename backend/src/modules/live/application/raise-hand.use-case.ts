import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  err,
  failure,
  ok,
  type Clock,
  type IdGenerator,
  type Result,
} from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  Permissions,
  type AuthorizationService,
  type Principal,
} from '../../identity/contracts';
import { speakerRequested } from '../domain/events';
import { isJoinable, type LiveSessionId } from '../domain/live-room';
import {
  LIVE_SESSION_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
  type LiveSessionRepository,
  type SpeakerRequestRepository,
} from '../domain/ports';
import { LiveJournal } from './live-journal';
import { speakerRequestView, type RaiseHandResult } from './views';

export interface RaiseHandCommand {
  readonly principal: Principal;
  readonly sessionId: string;
}

/**
 * A participant raises their hand. Idempotent: raising a hand that is already
 * up (pending or granted) answers with that same request — no second row, no
 * second event — so a double tap or a retry is harmless.
 *
 * Note what this does NOT do: it does not touch the media provider. A raised
 * hand is application state, not media state — the participant stays a
 * listener until a moderator grants the floor. That separation is what keeps
 * the queue cheap in a large session.
 */
@Injectable()
export class RaiseHandUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly journal: LiveJournal,
  ) {}

  async execute(command: RaiseHandCommand): Promise<Result<RaiseHandResult>> {
    const allowed = this.authorization.authorize(command.principal, Permissions.live.raiseHand);
    if (!allowed.ok) return allowed;

    const session = await this.sessions.findById(command.sessionId as LiveSessionId);
    if (session === null) {
      return err(failure('not_found', 'live.session_not_found', 'No such live session.'));
    }
    if (!isJoinable(session)) {
      return err(
        failure('precondition_failed', 'live.session_not_live', 'This session is not live.'),
      );
    }

    const now = this.clock.now();
    const outcome = await this.requests.raise({
      id: this.ids.next<'SpeakerRequest'>(),
      sessionId: session.id,
      userId: command.principal.userId,
      state: 'pending',
      requestedAt: now,
      grantedAt: null,
      decidedAt: null,
      decidedBy: null,
    });
    if (outcome.created) {
      await this.journal.announced(
        speakerRequested(session.id, outcome.request.id, outcome.request.userId, now),
      );
    }
    return ok({ created: outcome.created, request: speakerRequestView(outcome.request) });
  }
}

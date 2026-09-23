import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, err, failure, ok, type Clock, type Result } from '../../../shared';
import type { Principal } from '../../identity/contracts';
import { speakerRequestWithdrawn } from '../domain/events';
import { isJoinable, type LiveSessionId } from '../domain/live-room';
import {
  LIVE_SESSION_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
  type LiveSessionRepository,
  type SpeakerRequestRepository,
} from '../domain/ports';
import { CapabilityConvergence } from './capability-convergence';
import { LiveJournal } from './live-journal';
import { speakerRequestView, type LowerHandResult } from './views';

export interface LowerHandCommand {
  readonly principal: Principal;
  readonly sessionId: string;
}

/**
 * A participant lowers their own hand: a pending hand is withdrawn, and a
 * speaker yields the floor (their microphone right ends at once). Nothing to
 * lower answers `{request: null}` — a retry, or a hand already decided, is
 * harmless. Only ever the caller's own hand: there is no request id to name
 * someone else's.
 *
 * Not moderation, so not audited: the person acted on their own request.
 */
@Injectable()
export class LowerHandUseCase {
  constructor(
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly convergence: CapabilityConvergence,
    private readonly journal: LiveJournal,
  ) {}

  async execute(command: LowerHandCommand): Promise<Result<LowerHandResult>> {
    const session = await this.sessions.findById(command.sessionId as LiveSessionId);
    if (session === null) {
      return err(failure('not_found', 'live.session_not_found', 'No such live session.'));
    }
    const open = await this.requests.findOpen(session.id, command.principal.userId);
    if (open === null) return ok({ request: null });
    if (!isJoinable(session)) {
      return err(
        failure('precondition_failed', 'live.session_not_live', 'This session is not live.'),
      );
    }

    const now = this.clock.now();
    const outcome = await this.requests.transition({
      requestId: open.id,
      from: [open.state],
      to: 'withdrawn',
      at: now,
      by: command.principal.userId,
      moderation: null,
    });
    if (outcome === null || outcome.kind === 'invalid') {
      // A moderator decided it first (revoked or declined): the hand is down,
      // but not by this request.
      return err(failure('conflict', 'live.invalid_transition', 'This hand was already decided.'));
    }
    if (outcome.kind === 'unchanged') return ok({ request: speakerRequestView(outcome.request) });

    if (open.state === 'granted') {
      // Yielding the floor: the microphone right ends now, on the wire too
      // (or on a later tick, if the provider does not take it at once).
      await this.convergence.apply(session.id, open.userId);
    }
    await this.journal.announced(
      speakerRequestWithdrawn(
        session.id,
        open.userId,
        open.state === 'granted' ? 'granted' : 'pending',
        now,
      ),
    );
    return ok({ request: speakerRequestView(outcome.request) });
  }
}

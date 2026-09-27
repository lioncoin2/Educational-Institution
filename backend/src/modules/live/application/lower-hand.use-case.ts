import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  err,
  ok,
  type CallMetadata,
  type Clock,
  type Principal,
  type Result,
} from '../../../shared';
import { speakerWithdrawn } from '../domain/events';
import {
  LIVE_SESSION_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
  type LiveSessionRepository,
  type SpeakerRequestRepository,
} from '../domain/ports';
import { lastOpenState } from '../domain/speaker-request';
import { LiveAccess } from './live-access';
import { LiveJournal } from './live-journal';
import { LiveMedia } from './live-media';
import { LiveRefusals, isLiveId } from './live-settings';
import { speakerRequestView, type LowerHandResult } from './views';

/**
 * A participant lowers their own hand (audit D9, D4): a pending hand is
 * withdrawn, and a speaker yields the floor. Only ever the caller's own —
 * there is no request id to name someone else's.
 *
 * The caller's open request comes first, found by (session, user). It needs
 * no permit: lowering only ever reduces privilege, so even someone who has
 * just lost their standing may put their hand down. The write is a
 * compare-and-set from EITHER open state, so a lower racing a grant still
 * wins, as a yield:
 *
 *   withdrawn from pending or granted   `live.speaker.withdrawn {from}`; a
 *                                       yield also pushes the caller's full
 *                                       set (the microphone off); 200
 *   already withdrawn                   200, unchanged
 *   already expired — the session       200 {request: null}: nothing is up
 *   ended, or the caller was expired
 *   already revoked or declined         409 live.invalid_transition: a
 *                                       moderator decided it first
 *
 * With no open request, the answer must not reveal the session to someone
 * who may not see it: 404 unless the session exists and the caller may see
 * it (a member refused only by the lifecycle included), else 200
 * {request: null} — a retry is harmless.
 *
 * Not moderation, so not audited: the person acted on their own request.
 */
@Injectable()
export class LowerHandUseCase {
  constructor(
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly media: LiveMedia,
    private readonly journal: LiveJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sessionId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<LowerHandResult>> {
    const { principal, sessionId } = command;
    if (!isLiveId(sessionId)) return err(LiveRefusals.sessionNotFound);
    const open = await this.requests.findOpen(sessionId, principal.userId);
    const session = await this.sessions.findById(sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);

    if (open === null) {
      const viewer = await this.access.viewer(principal, session, LiveRefusals.sessionNotFound);
      return viewer.ok ? ok({ request: null }) : viewer;
    }

    const outcome = await this.requests.transition({
      requestId: open.id,
      // Either open state: a grant that committed since the read above is
      // yielded, never refused.
      from: ['pending', 'granted'],
      to: 'withdrawn',
      at: this.clock.now(),
      by: principal.userId,
      moderation: null,
    });
    if (outcome === null) return ok({ request: null });
    switch (outcome.kind) {
      case 'unchanged':
        return ok({ request: speakerRequestView(outcome.request) });
      case 'session_not_live':
        return ok({ request: null });
      case 'invalid':
        return outcome.request.state === 'expired'
          ? ok({ request: null })
          : err(LiveRefusals.invalidTransition);
      case 'applied':
        break;
    }

    if (lastOpenState(outcome.request) === 'granted') {
      // A yield: the microphone right ends now, on the wire too — or, if the
      // provider does not take it, when the watch lands it.
      await this.media.push(session, principal.userId);
    }
    await this.journal.record(null, [
      speakerWithdrawn(session, outcome.request, outcome.stateVersion, command.meta.correlationId),
    ]);
    return ok({ request: speakerRequestView(outcome.request) });
  }
}

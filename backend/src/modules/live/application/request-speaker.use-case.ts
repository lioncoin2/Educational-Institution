import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  EVENT_PUBLISHER,
  ID_GENERATOR,
  err,
  failure,
  ok,
  type Clock,
  type EventPublisher,
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
import { isJoinable } from '../domain/live-room';
import {
  LIVE_SESSION_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
  type LiveSessionRepository,
  type SpeakerRequestRepository,
} from '../domain/ports';
import { hasOpenRequest, type SpeakerRequest } from '../domain/speaker-request';

export interface RequestSpeakerCommand {
  readonly principal: Principal;
  readonly sessionId: string;
  readonly displayName: string;
}

/**
 * A participant raises their hand.
 *
 * Note what this does NOT do: it does not touch the RTC provider. Raising a hand
 * is application state, not media state — the participant's token is unchanged
 * and they stay a listener until a host grants them the floor. That separation
 * is what keeps the queue cheap at 2500 participants.
 */
@Injectable()
export class RequestSpeakerUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  async execute(command: RequestSpeakerCommand): Promise<Result<SpeakerRequest>> {
    const allowed = this.authorization.authorize(command.principal, Permissions.live.raiseHand);
    if (!allowed.ok) return allowed;

    const session = await this.sessions.findById(command.sessionId as never);
    if (session === null) {
      return err(failure('not_found', 'live.session_not_found', 'No such live session.'));
    }
    if (!isJoinable(session)) {
      return err(
        failure('precondition_failed', 'live.session_not_live', 'This session is not live.'),
      );
    }

    const existing = await this.requests.findBySession(session.id);
    if (hasOpenRequest(existing, command.principal.userId)) {
      return err(
        failure('conflict', 'live.speaker_request_exists', 'Your hand is already raised.'),
      );
    }

    const now = this.clock.now();
    const request: SpeakerRequest = {
      id: this.ids.next<'SpeakerRequest'>(),
      sessionId: session.id,
      userId: command.principal.userId,
      displayName: command.displayName,
      state: 'pending',
      requestedAt: now,
      decidedAt: null,
      decidedBy: null,
    };

    await this.requests.save(request);
    await this.events.publish([speakerRequested(session.id, request.id, request.userId, now)]);

    return ok(request);
  }
}

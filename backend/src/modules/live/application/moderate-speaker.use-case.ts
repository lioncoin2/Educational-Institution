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
import { speakerPermissionGranted, speakerPermissionRevoked } from '../domain/events';
import type { ModerationAction, ModerationActionType } from '../domain/moderation';
import {
  MODERATION_LOG,
  SPEAKER_REQUEST_REPOSITORY,
  type ModerationLog,
  type SpeakerRequestRepository,
} from '../domain/ports';
import { LISTENER, RTC_PROVIDER, SPEAKER, type RtcProvider } from '../domain/rtc-provider';
import { speakerSlotsAvailable, transition, type SpeakerRequest } from '../domain/speaker-request';

export interface ModerateSpeakerCommand {
  readonly principal: Principal;
  readonly requestId: string;
}

/**
 * The host granting or withdrawing the floor.
 *
 * Both directions follow the same shape, and the order is deliberate:
 * change our own state first, then the provider, then record the action. If the
 * provider call fails the use case fails loudly rather than leaving the room and
 * our records disagreeing — see open-questions.md (Q5) on reconciliation.
 */
@Injectable()
export class ModerateSpeakerUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
    @Inject(RTC_PROVIDER) private readonly rtc: RtcProvider,
    @Inject(MODERATION_LOG) private readonly moderation: ModerationLog,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  async grant(command: ModerateSpeakerCommand): Promise<Result<SpeakerRequest>> {
    const allowed = this.authorization.authorize(command.principal, Permissions.live.grantSpeaker);
    if (!allowed.ok) return allowed;

    const request = await this.requests.findById(command.requestId);
    if (request === null) {
      return err(failure('not_found', 'live.request_not_found', 'No such speaker request.'));
    }

    const siblings = await this.requests.findBySession(request.sessionId);
    if (!speakerSlotsAvailable(siblings)) {
      return err(
        failure(
          'precondition_failed',
          'live.speaker_slots_full',
          'The maximum number of speakers already hold the floor.',
        ),
      );
    }

    const now = this.clock.now();
    const granted = transition(request, 'granted', now, command.principal.userId);
    if (granted === null) {
      return err(
        failure('conflict', 'live.invalid_transition', 'This request can no longer be granted.'),
      );
    }

    await this.requests.save(granted);
    await this.rtc.updateCapabilities(granted.sessionId, granted.userId, SPEAKER);
    await this.record(
      granted.sessionId,
      command.principal.userId,
      granted.userId,
      'grant_speaker',
      now,
    );
    await this.events.publish([
      speakerPermissionGranted(granted.sessionId, granted.userId, command.principal.userId, now),
    ]);

    return ok(granted);
  }

  async revoke(command: ModerateSpeakerCommand): Promise<Result<SpeakerRequest>> {
    const allowed = this.authorization.authorize(command.principal, Permissions.live.revokeSpeaker);
    if (!allowed.ok) return allowed;

    const request = await this.requests.findById(command.requestId);
    if (request === null) {
      return err(failure('not_found', 'live.request_not_found', 'No such speaker request.'));
    }

    const now = this.clock.now();
    const revoked = transition(request, 'revoked', now, command.principal.userId);
    if (revoked === null) {
      return err(
        failure('conflict', 'live.invalid_transition', 'This request is not currently granted.'),
      );
    }

    await this.requests.save(revoked);
    // Demote on the wire: the participant stays in the room as a listener.
    await this.rtc.updateCapabilities(revoked.sessionId, revoked.userId, LISTENER);
    await this.record(
      revoked.sessionId,
      command.principal.userId,
      revoked.userId,
      'revoke_speaker',
      now,
    );
    await this.events.publish([
      speakerPermissionRevoked(revoked.sessionId, revoked.userId, command.principal.userId, now),
    ]);

    return ok(revoked);
  }

  private async record(
    sessionId: string,
    actorUserId: string,
    targetUserId: string,
    type: ModerationActionType,
    at: Date,
  ): Promise<void> {
    const action: ModerationAction = {
      id: this.ids.next<'ModerationAction'>(),
      sessionId,
      actorUserId,
      targetUserId,
      type,
      at,
    };
    await this.moderation.record(action);
  }
}

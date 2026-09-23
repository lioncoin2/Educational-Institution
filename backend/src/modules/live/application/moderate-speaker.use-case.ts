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
import {
  speakerPermissionGranted,
  speakerPermissionRevoked,
  speakerRequestDeclined,
} from '../domain/events';
import { isJoinable, type LiveSession, type LiveSessionId } from '../domain/live-room';
import type { ModerationAction, ModerationActionType } from '../domain/moderation';
import {
  LIVE_ROOM_REPOSITORY,
  LIVE_SESSION_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
  type LiveRoomRepository,
  type LiveSessionRepository,
  type SpeakerRequestRepository,
} from '../domain/ports';
import { MAX_CONCURRENT_SPEAKERS, type SpeakerRequest } from '../domain/speaker-request';
import { CapabilityConvergence } from './capability-convergence';
import { LiveJournal } from './live-journal';
import { speakerRequestView, type ModerationResult, type SpeakerRequestView } from './views';

export interface ModerateSpeakerCommand {
  readonly principal: Principal;
  readonly requestId: string;
}

const invalid = (message: string) => err(failure('conflict', 'live.invalid_transition', message));
const notLive = () =>
  err(failure('precondition_failed', 'live.session_not_live', 'This session is not live.'));

/**
 * A moderator giving, refusing or taking back the floor.
 *
 * Authorization is asked of identity twice, deliberately. First coarsely —
 * "may this principal moderate at all?" — before anything is loaded, so a
 * caller without the permission cannot learn which requests exist. Then with
 * the room's host in context — "may they moderate THIS room?" — which is the
 * question that matters, and which identity's policy answers (Q1). Live never
 * decides access itself.
 *
 * Every decision is idempotent: repeating one already taken answers 200 with
 * the request as it is, changes nothing, and records nothing. A move outside
 * the state table is 409.
 *
 * Order: live's own record first (the source of truth), then the media
 * provider, then the audit entry and the event. The provider's answer is
 * reported, never assumed: `applied`, `not_connected` (the next join carries
 * it), or `pending` (the provider did not take it yet) — and in every case
 * the person is watched until the media plane has converged
 * (`CapabilityConvergence`), so neither a revoked speaker nor a granted one
 * is left with the wrong rights. A provider failure never fails the
 * decision: it is already stored, so it is always audited and announced.
 */
@Injectable()
export class ModerateSpeakerUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly liveSessions: LiveSessionRepository,
    @Inject(LIVE_ROOM_REPOSITORY) private readonly rooms: LiveRoomRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly convergence: CapabilityConvergence,
    private readonly journal: LiveJournal,
  ) {}

  async grant(command: ModerateSpeakerCommand): Promise<Result<ModerationResult>> {
    const loaded = await this.loadAuthorized(command);
    if (!loaded.ok) return loaded;
    const { request, session } = loaded.value;
    if (request.state === 'granted')
      return ok({ request: speakerRequestView(request), media: 'unchanged' });
    if (!isJoinable(session)) return notLive();

    const now = this.clock.now();
    const action = this.action('grant_speaker', command, request, now);
    const outcome = await this.requests.grantWithinCap({
      requestId: request.id,
      cap: MAX_CONCURRENT_SPEAKERS,
      at: now,
      by: command.principal.userId,
      moderation: action,
    });
    if (outcome === null) return this.notFound();
    switch (outcome.kind) {
      case 'unchanged':
        return ok({ request: speakerRequestView(outcome.request), media: 'unchanged' });
      case 'invalid':
        return invalid('This request can no longer be granted.');
      case 'slots_full':
        return err(
          failure(
            'precondition_failed',
            'live.speaker_slots_full',
            'The maximum number of speakers already hold the floor.',
          ),
        );
      case 'granted': {
        const media = await this.convergence.apply(session.id, outcome.request.userId);
        await this.journal.moderated(
          action,
          speakerPermissionGranted(
            session.id,
            outcome.request.userId,
            command.principal.userId,
            now,
          ),
          { requestId: request.id, media },
        );
        return ok({ request: speakerRequestView(outcome.request), media });
      }
    }
  }

  async revoke(command: ModerateSpeakerCommand): Promise<Result<ModerationResult>> {
    const loaded = await this.loadAuthorized(command);
    if (!loaded.ok) return loaded;
    const { request, session } = loaded.value;
    if (request.state === 'revoked')
      return ok({ request: speakerRequestView(request), media: 'unchanged' });
    if (!isJoinable(session)) return notLive();

    const now = this.clock.now();
    const action = this.action('revoke_speaker', command, request, now);
    const outcome = await this.requests.transition({
      requestId: request.id,
      from: ['granted'],
      to: 'revoked',
      at: now,
      by: command.principal.userId,
      moderation: action,
    });
    if (outcome === null) return this.notFound();
    if (outcome.kind === 'unchanged') {
      return ok({ request: speakerRequestView(outcome.request), media: 'unchanged' });
    }
    if (outcome.kind === 'invalid') return invalid('This request is not currently granted.');

    // Demote on the wire: the participant stays in the room as a listener.
    const media = await this.convergence.apply(session.id, outcome.request.userId);
    await this.journal.moderated(
      action,
      speakerPermissionRevoked(session.id, outcome.request.userId, command.principal.userId, now),
      { requestId: request.id, media },
    );
    return ok({ request: speakerRequestView(outcome.request), media });
  }

  /** Passing over a pending hand. No media change: the person was never speaking. */
  async decline(
    command: ModerateSpeakerCommand,
  ): Promise<Result<{ readonly request: SpeakerRequestView }>> {
    const loaded = await this.loadAuthorized(command);
    if (!loaded.ok) return loaded;
    const { request, session } = loaded.value;
    if (request.state === 'declined') return ok({ request: speakerRequestView(request) });
    if (!isJoinable(session)) return notLive();

    const now = this.clock.now();
    const action = this.action('decline_speaker', command, request, now);
    const outcome = await this.requests.transition({
      requestId: request.id,
      from: ['pending'],
      to: 'declined',
      at: now,
      by: command.principal.userId,
      moderation: action,
    });
    if (outcome === null) return this.notFound();
    if (outcome.kind === 'unchanged') return ok({ request: speakerRequestView(outcome.request) });
    if (outcome.kind === 'invalid') return invalid('Only a raised hand can be declined.');

    await this.journal.moderated(
      action,
      speakerRequestDeclined(session.id, outcome.request.userId, command.principal.userId, now),
      { requestId: request.id },
    );
    return ok({ request: speakerRequestView(outcome.request) });
  }

  private action(
    type: ModerationActionType,
    command: ModerateSpeakerCommand,
    request: SpeakerRequest,
    at: Date,
  ): ModerationAction {
    return {
      id: this.ids.next<'ModerationAction'>(),
      sessionId: request.sessionId,
      actorUserId: command.principal.userId,
      targetUserId: request.userId,
      type,
      at,
    };
  }

  private notFound() {
    return err(failure('not_found', 'live.request_not_found', 'No such speaker request.'));
  }

  /**
   * Coarse check, load, then the room-scoped check. A request whose session or
   * room cannot be found is reported as not found — never "forbidden", which
   * would confirm it exists.
   */
  private async loadAuthorized(
    command: ModerateSpeakerCommand,
  ): Promise<Result<{ readonly request: SpeakerRequest; readonly session: LiveSession }>> {
    const allowed = this.authorization.authorize(command.principal, Permissions.live.moderate);
    if (!allowed.ok) return allowed;

    const request = await this.requests.findById(command.requestId);
    if (request === null) return this.notFound();
    const session = await this.liveSessions.findById(request.sessionId as LiveSessionId);
    if (session === null) return this.notFound();
    const room = await this.rooms.findById(session.roomId);
    if (room === null) return this.notFound();

    const inThisRoom = this.authorization.authorize(command.principal, Permissions.live.moderate, {
      resourceType: 'live.session',
      resourceId: session.id,
      ownerUserId: room.hostUserId,
    });
    if (!inThisRoom.ok) return inThisRoom;

    return ok({ request, session });
  }
}

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
import type { CommunityPermit } from '../../communities/contracts/authorization';
import {
  AUTHORIZATION_SERVICE,
  Permissions,
  type AuthorizationService,
} from '../../identity/contracts';
import { speakerDeclined, speakerGranted, speakerRevoked } from '../domain/events';
import { MAX_CONCURRENT_SPEAKERS } from '../domain/live-limits';
import type { LiveSession } from '../domain/live-session';
import type { ModerationAction, ModerationActionType } from '../domain/moderation';
import {
  LIVE_SESSION_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
  type LiveSessionRepository,
  type SpeakerRequestRepository,
  type TransitionOutcome,
} from '../domain/ports';
import type { SpeakerRequest } from '../domain/speaker-request';
import { askCommunities } from './community-calls';
import { LiveAccess, permitOf } from './live-access';
import { LiveJournal, moderationAudit } from './live-journal';
import { LiveMedia } from './live-media';
import { LiveRefusals } from './live-settings';
import { LiveStanding } from './live-standing';
import {
  speakerRequestView,
  type DeclineResult,
  type MediaOutcome,
  type ModerationResult,
} from './views';

export interface ModerateSpeakerCommand {
  readonly principal: Principal;
  readonly requestId: string;
  readonly meta: CallMetadata;
}

/** A request, its session, and the permit its moderator acts on. */
interface Moderated {
  readonly request: SpeakerRequest;
  readonly session: LiveSession;
  readonly permit: CommunityPermit;
}

/**
 * A moderator giving, refusing or taking back the floor (live.md §5.1, S3).
 *
 *   1. identity's coarse `live.moderate`, before anything is read — a caller
 *      who may not moderate at all learns nothing about which requests exist;
 *   2. the request and its session → 404 live.request_not_found;
 *   3. `LiveAccess.moderator` on the session's own community → 404 like an
 *      unknown request, 403 live.not_a_moderator, 503;
 *   4. the host's own request, acted on by anyone but the host → 403
 *      live.target_is_host (PROVISIONAL, Q54): a delegated moderator — the
 *      community's owner included — never acts on the host;
 *   5. a repeat of the request's current state → 200, and nothing else
 *      happens (audit D6);
 *   6. grant only: the requester may still take part — Communities'
 *      `community.live.remain`, or they moderate the session — else 412
 *      live.target_not_eligible;
 *   7. the compare-and-set, under the session's lock: 412
 *      live.speaker_slots_full at the cap, 409 live.invalid_transition from
 *      any other state, 412 live.session_not_live after the end;
 *   8. after commit, for a grant or a revoke: the requester's full current set
 *      pushed, reported as `media` — never a failure, since the decision is
 *      stored (`LiveMedia`);
 *   9. the journal: the act's own audit action, with the permit it ran on,
 *      the target, the request and the media outcome, then the event with the
 *      session's new version.
 */
@Injectable()
export class ModerateSpeakerUseCase {
  private readonly logger = new Logger(ModerateSpeakerUseCase.name);

  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly access: LiveAccess,
    private readonly standing: LiveStanding,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly media: LiveMedia,
    private readonly journal: LiveJournal,
  ) {}

  async grant(command: ModerateSpeakerCommand): Promise<Result<ModerationResult>> {
    const loaded = await this.load(command);
    if (!loaded.ok) return loaded;
    const { request, session, permit } = loaded.value;
    if (request.state === 'granted') return unchanged(request);

    const eligible = await askCommunities(this.logger, () =>
      this.standing.ofAccounts(session, [request.userId]),
    );
    if (!eligible.ok) return eligible;
    if (eligible.value.get(request.userId)?.eligible !== true) {
      return err(LiveRefusals.targetNotEligible);
    }

    const action = this.action('grant_speaker', command.principal, request);
    const outcome = await this.requests.grantWithinCap({
      requestId: request.id,
      cap: MAX_CONCURRENT_SPEAKERS,
      at: action.at,
      by: command.principal.userId,
      moderation: action,
    });
    if (outcome === null) return err(LiveRefusals.requestNotFound);
    switch (outcome.kind) {
      case 'unchanged':
        return unchanged(outcome.request);
      case 'slots_full':
        return err(LiveRefusals.speakerSlotsFull);
      case 'invalid':
        return err(LiveRefusals.invalidTransition);
      case 'session_not_live':
        return err(LiveRefusals.sessionNotLive);
      case 'granted':
        break;
    }

    // The microphone on, on the wire too — or when the watch lands it.
    const media = await this.media.push(session, request.userId);
    await this.journal.record(
      moderationAudit(action, {
        communityId: session.communityId,
        detail: { requestId: request.id, media, permit: permitOf(permit) },
        correlationId: command.meta.correlationId,
      }),
      [speakerGranted(session, outcome.request, outcome.stateVersion, command.meta.correlationId)],
    );
    return ok({ request: speakerRequestView(outcome.request), media });
  }

  async revoke(command: ModerateSpeakerCommand): Promise<Result<ModerationResult>> {
    const loaded = await this.load(command);
    if (!loaded.ok) return loaded;
    const { request, session, permit } = loaded.value;
    if (request.state === 'revoked') return unchanged(request);

    const action = this.action('revoke_speaker', command.principal, request);
    const outcome = await this.transition(action, request, ['granted'], 'revoked');
    if (!outcome.ok) return outcome;
    if (outcome.value.kind === 'unchanged') return unchanged(outcome.value.request);

    // Demoted, not removed: the person stays in the room as a listener —
    // unless they publish by right, which a recomputed set keeps.
    const media = await this.media.push(session, request.userId);
    await this.journal.record(
      moderationAudit(action, {
        communityId: session.communityId,
        detail: { requestId: request.id, media, permit: permitOf(permit) },
        correlationId: command.meta.correlationId,
      }),
      [
        speakerRevoked(
          session,
          outcome.value.request,
          outcome.value.stateVersion,
          command.meta.correlationId,
        ),
      ],
    );
    return ok({ request: speakerRequestView(outcome.value.request), media });
  }

  /** Passing over a pending hand. No media change: the person was never speaking. */
  async decline(command: ModerateSpeakerCommand): Promise<Result<DeclineResult>> {
    const loaded = await this.load(command);
    if (!loaded.ok) return loaded;
    const { request, session, permit } = loaded.value;
    if (request.state === 'declined') return ok({ request: speakerRequestView(request) });

    const action = this.action('decline_speaker', command.principal, request);
    const outcome = await this.transition(action, request, ['pending'], 'declined');
    if (!outcome.ok) return outcome;
    if (outcome.value.kind === 'applied') {
      await this.journal.record(
        moderationAudit(action, {
          communityId: session.communityId,
          detail: { requestId: request.id, permit: permitOf(permit) },
          correlationId: command.meta.correlationId,
        }),
        [
          speakerDeclined(
            session,
            outcome.value.request,
            outcome.value.stateVersion,
            command.meta.correlationId,
          ),
        ],
      );
    }
    return ok({ request: speakerRequestView(outcome.value.request) });
  }

  /** Steps 1–4. */
  private async load(command: ModerateSpeakerCommand): Promise<Result<Moderated>> {
    const { principal } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.moderate);
    if (!allowed.ok) return allowed;

    const request = await this.requests.findById(command.requestId);
    if (request === null) return err(LiveRefusals.requestNotFound);
    const session = await this.sessions.findById(request.sessionId);
    if (session === null) return err(LiveRefusals.requestNotFound);
    const permit = await this.access.moderator(principal, session, LiveRefusals.requestNotFound);
    if (!permit.ok) return permit;
    if (request.userId === session.hostUserId && principal.userId !== session.hostUserId) {
      return err(LiveRefusals.targetIsHost);
    }
    return ok({ request, session, permit: permit.value });
  }

  /** Step 7 for decline and revoke: applied or unchanged, or the refusal. */
  private async transition(
    action: ModerationAction,
    request: SpeakerRequest,
    from: readonly SpeakerRequest['state'][],
    to: 'declined' | 'revoked',
  ): Promise<Result<TransitionOutcome & { readonly kind: 'applied' | 'unchanged' }>> {
    const outcome = await this.requests.transition({
      requestId: request.id,
      from,
      to,
      at: action.at,
      by: action.actorUserId,
      moderation: action,
    });
    if (outcome === null) return err(LiveRefusals.requestNotFound);
    switch (outcome.kind) {
      case 'invalid':
        return err(LiveRefusals.invalidTransition);
      case 'session_not_live':
        return err(LiveRefusals.sessionNotLive);
      case 'applied':
      case 'unchanged':
        return ok({ ...outcome, kind: outcome.kind });
    }
  }

  private action(
    type: ModerationActionType,
    principal: Principal,
    request: SpeakerRequest,
  ): ModerationAction {
    return {
      id: this.ids.next<'ModerationAction'>(),
      sessionId: request.sessionId,
      actorUserId: principal.userId,
      targetUserId: request.userId,
      type,
      at: this.clock.now(),
    };
  }
}

/** A repeat of a decision already taken: 200 with the request as it is, and nothing sent. */
function unchanged(request: SpeakerRequest): Result<ModerationResult> {
  return ok({ request: speakerRequestView(request), media: 'unchanged' satisfies MediaOutcome });
}

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';

import type { CallMetadata, Principal } from '../../../shared';
import { RequestMetadata } from '../../../platform/http/call-metadata.decorator';
import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { DatabaseUnavailableInterceptor } from '../../../platform/http/database-unavailable.interceptor';
import { unwrap } from '../../../platform/http/http-failure';
import { Authenticated, Permissions, RequirePermission } from '../../identity/contracts';
import { EndLiveSessionUseCase } from '../application/end-live-session.use-case';
import { GetCurrentLiveSessionUseCase } from '../application/get-current-live-session.use-case';
import { GetLiveSessionUseCase } from '../application/get-live-session.use-case';
import { JoinLiveSessionUseCase } from '../application/join-live-session.use-case';
import { KickParticipantUseCase } from '../application/kick-participant.use-case';
import { ListHandsUseCase } from '../application/list-hands.use-case';
import { LowerHandUseCase } from '../application/lower-hand.use-case';
import { ModerateSpeakerUseCase } from '../application/moderate-speaker.use-case';
import { PresenterUseCase } from '../application/presenter.use-case';
import { RaiseHandUseCase } from '../application/raise-hand.use-case';
import { ResetRoomUseCase } from '../application/reset-room.use-case';
import { StartLiveSessionUseCase } from '../application/start-live-session.use-case';
import { HandsQuery } from './dto/live.dto';
import {
  toCurrentSessionResponse,
  toHandsPageResponse,
  toJoinTicketResponse,
  toLiveSessionResponse,
  toModerationResponse,
  toParticipantRemovedResponse,
  toRequestResponse,
  toRoomResetResponse,
} from './responses';

/**
 * /live — community-scoped live sessions (live.md §15; the P6 audit §11).
 *
 * Every route declares the access it needs, and the guard resolves that
 * through identity: `live.join` to see and join, `live.raise_hand` to ask for
 * the floor, `live.moderate` for every moderator's act — and an account alone
 * to lower one's own hand or stop one's own screen share, which only ever
 * reduce the caller's own privilege. The edge is never the decision: every use
 * case asks Communities again, about the community the session's own record
 * names, so a caller learns nothing about a session they may not see — one
 * 404, whether it exists or not.
 *
 * No route takes a body. Who the caller is, which hand is theirs, what they
 * may publish and what they are called are the server's to know; a name, a
 * role or a user id sent by a client would be a claim nobody checks. Nothing
 * here decides access, and nothing here talks to the media provider.
 *
 * Fail closed, and say so: a store that cannot be reached answers 503
 * `unavailable` (the interceptor, as on every Communities route), and so does
 * Communities when it cannot answer (the use cases map that) — never an
 * answer computed from roles alone.
 */
@Controller('live')
@UseInterceptors(DatabaseUnavailableInterceptor)
export class LiveController {
  constructor(
    private readonly startSession: StartLiveSessionUseCase,
    private readonly currentSession: GetCurrentLiveSessionUseCase,
    private readonly getSession: GetLiveSessionUseCase,
    private readonly joinSession: JoinLiveSessionUseCase,
    private readonly endSession: EndLiveSessionUseCase,
    private readonly raiseHand: RaiseHandUseCase,
    private readonly lowerHand: LowerHandUseCase,
    private readonly listHands: ListHandsUseCase,
    private readonly moderate: ModerateSpeakerUseCase,
    private readonly presenter: PresenterUseCase,
    private readonly kickParticipant: KickParticipantUseCase,
    private readonly resetRoom: ResetRoomUseCase,
  ) {}

  /**
   * 201 with the new session, the caller its host; 200 with the one already
   * running — a repeat, a start that lost a race, or one retried after the
   * community was locked. 503 `live.media_unavailable`, with nothing stored,
   * when the media room cannot be made.
   */
  @Post('communities/:communityId/sessions')
  @RequirePermission(Permissions.live.moderate)
  async start(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = unwrap(await this.startSession.execute({ principal, communityId, meta }));
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return toLiveSessionResponse(result.session);
  }

  /** "Live now": the community's running session, or `{session: null}`. */
  @Get('communities/:communityId/sessions/current')
  @RequirePermission(Permissions.live.join)
  async current(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
  ) {
    const result = unwrap(await this.currentSession.execute({ principal, communityId }));
    return toCurrentSessionResponse(result.session);
  }

  /** One session as the caller sees it — ended ones included. */
  @Get('sessions/:sessionId')
  @RequirePermission(Permissions.live.join)
  async get(@CurrentPrincipal() principal: Principal, @Param('sessionId') sessionId: string) {
    return toLiveSessionResponse(unwrap(await this.getSession.execute({ principal, sessionId })));
  }

  /**
   * A short-lived join ticket for the session's media room, scoped to what
   * the caller may publish now — the only response that carries a
   * credential. Decided afresh on every call: it is also the way back in.
   */
  @Post('sessions/:sessionId/join')
  @RequirePermission(Permissions.live.join)
  @HttpCode(HttpStatus.OK)
  async join(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toJoinTicketResponse(
      unwrap(await this.joinSession.execute({ principal, sessionId, meta })),
    );
  }

  /** Any of the session's moderators may end it; ending an ended session answers 200 and changes nothing. */
  @Post('sessions/:sessionId/end')
  @RequirePermission(Permissions.live.moderate)
  @HttpCode(HttpStatus.OK)
  async end(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toLiveSessionResponse(
      unwrap(await this.endSession.execute({ principal, sessionId, meta })),
    );
  }

  /** 201 with a new hand; 200 with the hand already up. */
  @Post('sessions/:sessionId/hand')
  @RequirePermission(Permissions.live.raiseHand)
  async raise(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = unwrap(await this.raiseHand.execute({ principal, sessionId, meta }));
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return toRequestResponse(result);
  }

  /** Lowers the caller's own hand, or yields the floor. `{request: null}` when nothing was up. */
  @Delete('sessions/:sessionId/hand')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async lower(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toRequestResponse(unwrap(await this.lowerHand.execute({ principal, sessionId, meta })));
  }

  /**
   * The moderators' view of the hands: the queue, first come first served,
   * in keyset pages — or who holds the floor. Names from the directory.
   */
  @Get('sessions/:sessionId/hands')
  @RequirePermission(Permissions.live.moderate)
  async hands(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @Query() query: HandsQuery,
  ) {
    return toHandsPageResponse(
      unwrap(
        await this.listHands.execute({
          principal,
          sessionId,
          state: query.state,
          cursor: query.cursor,
          limit: query.limit,
        }),
      ),
    );
  }

  /** Gives the floor; `media` says whether the provider already has it. A repeat answers `unchanged`. */
  @Post('requests/:requestId/grant')
  @RequirePermission(Permissions.live.moderate)
  @HttpCode(HttpStatus.OK)
  async grant(
    @CurrentPrincipal() principal: Principal,
    @Param('requestId') requestId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toModerationResponse(unwrap(await this.moderate.grant({ principal, requestId, meta })));
  }

  /** Passes over a pending hand. */
  @Post('requests/:requestId/decline')
  @RequirePermission(Permissions.live.moderate)
  @HttpCode(HttpStatus.OK)
  async decline(
    @CurrentPrincipal() principal: Principal,
    @Param('requestId') requestId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toRequestResponse(unwrap(await this.moderate.decline({ principal, requestId, meta })));
  }

  /** Takes the floor back; the speaker stays in the room as a listener. */
  @Post('requests/:requestId/revoke')
  @RequirePermission(Permissions.live.moderate)
  @HttpCode(HttpStatus.OK)
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('requestId') requestId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toModerationResponse(unwrap(await this.moderate.revoke({ principal, requestId, meta })));
  }

  /**
   * A by-right presenter (owner/moderator/teacher holding `live.speak`) claims
   * a screen-share slot for themself (Q56): 201 when this call opened one, 200
   * when they already held one; 409 `live.presenter_slots_full` at the cap.
   */
  @Post('sessions/:sessionId/screen-share')
  @RequirePermission(Permissions.live.moderate)
  async claimScreenShare(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = unwrap(await this.presenter.claim({ principal, sessionId, meta }));
    response.status(result.opened ? HttpStatus.CREATED : HttpStatus.OK);
    return toLiveSessionResponse(result.session);
  }

  /**
   * A moderator grants a participant (a student) a delegated screen-share slot
   * (Q56): 201 when opened, 200 when they already held one, 409 at the cap. The
   * `:userId` names the target only; who may grant is the server's own
   * `live.moderate` + Communities decision, and the target is validated as a
   * current participant (404 otherwise). The student presents without
   * `live.speak`, for this session only, until they stop or it is revoked.
   */
  @Post('sessions/:sessionId/screen-share/:userId/grant')
  @RequirePermission(Permissions.live.moderate)
  async grantScreenShare(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @Param('userId') userId: string,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = unwrap(
      await this.presenter.grant({ principal, sessionId, targetUserId: userId, meta }),
    );
    response.status(result.opened ? HttpStatus.CREATED : HttpStatus.OK);
    return toLiveSessionResponse(result.session);
  }

  /** The caller stops their OWN screen share; nothing open answers 200 too. No permit needed. */
  @Delete('sessions/:sessionId/screen-share')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async stopScreenShare(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toLiveSessionResponse(unwrap(await this.presenter.stop({ principal, sessionId, meta })));
  }

  /**
   * A moderator revokes a participant's screen-share grant (Q56): nothing open
   * for them answers 200 too. The `:userId` names the target only; who may
   * revoke is the server's `live.moderate` + Communities decision, and only
   * the host may revoke the host's own grant (Q54).
   */
  @Delete('sessions/:sessionId/screen-share/:userId')
  @RequirePermission(Permissions.live.moderate)
  @HttpCode(HttpStatus.OK)
  async revokeScreenShare(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @Param('userId') userId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toLiveSessionResponse(
      unwrap(await this.presenter.revoke({ principal, sessionId, targetUserId: userId, meta })),
    );
  }

  /**
   * A moderator removes a participant from the session's media room (Q64): an
   * administrative disconnect, never a ban — `{ removed: false }` when they
   * were not connected. `reason` is an optional code; the removed person is
   * told, and may re-join at once. The `:userId` names the target only; who may
   * remove is the server's own `live.moderate` + Communities decision.
   */
  @Post('sessions/:sessionId/participants/:userId/remove')
  @RequirePermission(Permissions.live.moderate)
  @HttpCode(HttpStatus.OK)
  async removeParticipant(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @Param('userId') userId: string,
    @Query('reason') reason: string | undefined,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toParticipantRemovedResponse(
      unwrap(
        await this.kickParticipant.execute({
          principal,
          sessionId,
          targetUserId: userId,
          reason,
          meta,
        }),
      ),
    );
  }

  /**
   * A moderator resets the session's media room (Q64): the room generation
   * moves on and the current participants re-join. `{ reset: false }` when a
   * concurrent reset or the end already moved it.
   */
  @Post('sessions/:sessionId/reset')
  @RequirePermission(Permissions.live.moderate)
  @HttpCode(HttpStatus.OK)
  async reset(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toRoomResetResponse(
      unwrap(await this.resetRoom.execute({ principal, sessionId, meta })),
    );
  }
}

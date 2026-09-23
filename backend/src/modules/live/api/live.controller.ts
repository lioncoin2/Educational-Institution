import { Controller, Delete, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import type { Principal } from '../../../shared';
import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import { Authenticated, Permissions, RequirePermission } from '../../identity/contracts';
import { JoinLiveSessionUseCase } from '../application/join-live-session.use-case';
import { LowerHandUseCase } from '../application/lower-hand.use-case';
import { ModerateSpeakerUseCase } from '../application/moderate-speaker.use-case';
import { RaiseHandUseCase } from '../application/raise-hand.use-case';

/**
 * The live-session edge.
 *
 * Every route declares the access it needs; the guard resolves it through
 * identity. Nothing here decides access, and nothing here talks to LiveKit.
 * No route takes a body: who the caller is, what they may do and what they
 * are called are all the server's to know — a display name or a role sent by
 * a client would be a claim nobody checks.
 */
@Controller('live')
export class LiveController {
  constructor(
    private readonly join: JoinLiveSessionUseCase,
    private readonly raiseHand: RaiseHandUseCase,
    private readonly lowerHand: LowerHandUseCase,
    private readonly moderate: ModerateSpeakerUseCase,
  ) {}

  /** A short-lived, capability-scoped join ticket. Call it again to re-join. */
  @Post('sessions/:sessionId/join')
  @RequirePermission(Permissions.live.join)
  @HttpCode(HttpStatus.OK)
  async joinSession(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
  ) {
    return unwrap(await this.join.execute({ principal, sessionId }));
  }

  /** 201 with a new hand; 200 with the hand already up. */
  @Post('sessions/:sessionId/hand')
  @RequirePermission(Permissions.live.raiseHand)
  async raise(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = unwrap(await this.raiseHand.execute({ principal, sessionId }));
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return { request: result.request };
  }

  /** Lowers the caller's own hand, or yields the floor. `{request: null}` when nothing was up. */
  @Delete('sessions/:sessionId/hand')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async lower(@CurrentPrincipal() principal: Principal, @Param('sessionId') sessionId: string) {
    return unwrap(await this.lowerHand.execute({ principal, sessionId }));
  }

  @Post('requests/:requestId/grant')
  @RequirePermission(Permissions.live.moderate)
  @HttpCode(HttpStatus.OK)
  async grant(@CurrentPrincipal() principal: Principal, @Param('requestId') requestId: string) {
    return unwrap(await this.moderate.grant({ principal, requestId }));
  }

  @Post('requests/:requestId/decline')
  @RequirePermission(Permissions.live.moderate)
  @HttpCode(HttpStatus.OK)
  async decline(@CurrentPrincipal() principal: Principal, @Param('requestId') requestId: string) {
    return unwrap(await this.moderate.decline({ principal, requestId }));
  }

  @Post('requests/:requestId/revoke')
  @RequirePermission(Permissions.live.moderate)
  @HttpCode(HttpStatus.OK)
  async revoke(@CurrentPrincipal() principal: Principal, @Param('requestId') requestId: string) {
    return unwrap(await this.moderate.revoke({ principal, requestId }));
  }
}

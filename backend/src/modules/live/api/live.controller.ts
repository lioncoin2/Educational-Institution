import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';

import type { Principal } from '../../../shared';
import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import { Permissions, RequirePermission } from '../../identity/contracts';
import { JoinLiveSessionUseCase } from '../application/join-live-session.use-case';
import { ModerateSpeakerUseCase } from '../application/moderate-speaker.use-case';
import { RequestSpeakerUseCase } from '../application/request-speaker.use-case';
import { JoinSessionDto } from './dto/join-session.dto';

/**
 * The live-room edge.
 *
 * Every route declares the permission it needs; the guard resolves it through
 * identity. Nothing here decides access, and nothing here talks to LiveKit.
 */
@Controller('live')
export class LiveController {
  constructor(
    private readonly join: JoinLiveSessionUseCase,
    private readonly raiseHand: RequestSpeakerUseCase,
    private readonly moderate: ModerateSpeakerUseCase,
  ) {}

  /** Returns a short-lived, capability-scoped token. */
  @Post('sessions/:sessionId/join')
  @RequirePermission(Permissions.live.joinRoom)
  @HttpCode(HttpStatus.OK)
  async joinSession(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @Body() dto: JoinSessionDto,
  ) {
    return unwrap(await this.join.execute({ principal, sessionId, displayName: dto.displayName }));
  }

  @Post('sessions/:sessionId/hand')
  @RequirePermission(Permissions.live.requestSpeaker)
  @HttpCode(HttpStatus.ACCEPTED)
  async raise(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @Body() dto: JoinSessionDto,
  ) {
    return unwrap(
      await this.raiseHand.execute({ principal, sessionId, displayName: dto.displayName }),
    );
  }

  @Post('requests/:requestId/grant')
  @RequirePermission(Permissions.live.grantSpeaker)
  @HttpCode(HttpStatus.OK)
  async grant(@CurrentPrincipal() principal: Principal, @Param('requestId') requestId: string) {
    return unwrap(await this.moderate.grant({ principal, requestId }));
  }

  @Post('requests/:requestId/revoke')
  @RequirePermission(Permissions.live.revokeSpeaker)
  @HttpCode(HttpStatus.OK)
  async revoke(@CurrentPrincipal() principal: Principal, @Param('requestId') requestId: string) {
    return unwrap(await this.moderate.revoke({ principal, requestId }));
  }
}

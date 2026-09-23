import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';

import { RequestMetadata } from '../../../platform/http/call-metadata.decorator';
import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import { RateLimit } from '../../../platform/http/rate-limit';
import type { CallMetadata, Principal } from '../../../shared';
import { ChangeMyPasswordUseCase } from '../application/change-password.use-case';
import { GetCurrentUserUseCase } from '../application/current-user.use-case';
import { LoginUseCase } from '../application/login.use-case';
import { AuthRateLimits } from '../application/rate-limit-policies';
import { RefreshSessionUseCase } from '../application/refresh-session.use-case';
import {
  ListMySessionsUseCase,
  LogoutUseCase,
  RevokeMySessionUseCase,
} from '../application/session-management.use-cases';
import { Authenticated, PublicRoute } from '../contracts/route-access';
import { ChangePasswordDto, LoginDto, RefreshDto } from './dto/auth.dto';
import {
  toCurrentUserResponse,
  toLoginResponse,
  toSessionResponse,
  toTokenResponse,
  type CurrentUserResponse,
  type LoginResponse,
  type SessionResponse,
  type TokenResponse,
} from './responses';

/**
 * Authentication and self-service: signing in and out, refreshing, and a
 * person managing their own account and devices.
 *
 * Nothing here acts on another account — that is /admin/users, a separate
 * controller behind separate permissions. There is no registration endpoint:
 * accounts are provisioned by staff.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly loginUseCase: LoginUseCase,
    private readonly refreshUseCase: RefreshSessionUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly currentUser: GetCurrentUserUseCase,
    private readonly listSessions: ListMySessionsUseCase,
    private readonly revokeSession: RevokeMySessionUseCase,
    private readonly changePasswordUseCase: ChangeMyPasswordUseCase,
  ) {}

  @Post('login')
  @PublicRoute()
  @RateLimit(AuthRateLimits.loginPerIp)
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<LoginResponse> {
    const signedIn = unwrap(
      await this.loginUseCase.execute({
        identifierKind: dto.identifierType ?? 'email',
        identifier: dto.identifier,
        password: dto.password,
        device: dto.device ?? {},
        meta,
      }),
    );
    return toLoginResponse(signedIn);
  }

  /** Public by necessity: it is called precisely when the access token has expired. */
  @Post('refresh')
  @PublicRoute()
  @RateLimit(AuthRateLimits.refreshPerIp)
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: RefreshDto,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<TokenResponse> {
    return toTokenResponse(
      unwrap(await this.refreshUseCase.execute({ refreshToken: dto.refreshToken, meta })),
    );
  }

  @Post('logout')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentPrincipal() principal: Principal,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<void> {
    unwrap(await this.logoutUseCase.execute({ principal, meta }));
  }

  @Get('me')
  @Authenticated()
  async me(@CurrentPrincipal() principal: Principal): Promise<CurrentUserResponse> {
    return toCurrentUserResponse(unwrap(await this.currentUser.execute({ principal })));
  }

  @Get('sessions')
  @Authenticated()
  async sessions(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly items: readonly SessionResponse[] }> {
    const sessions = unwrap(await this.listSessions.execute({ principal }));
    return { items: sessions.map(toSessionResponse) };
  }

  @Delete('sessions/:sessionId')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async endSession(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<void> {
    unwrap(await this.revokeSession.execute({ principal, sessionId, meta }));
  }

  @Post('password')
  @Authenticated()
  @RateLimit(AuthRateLimits.passwordPerIp)
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: ChangePasswordDto,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<void> {
    unwrap(
      await this.changePasswordUseCase.execute({
        principal,
        currentPassword: dto.currentPassword,
        newPassword: dto.newPassword,
        meta,
      }),
    );
  }
}

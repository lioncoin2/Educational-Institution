import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { FailureException } from '../../../../platform/http/http-failure';
import { failure } from '../../../../shared';
import { ResolvePrincipalUseCase } from '../../application/resolve-principal.use-case';
import { AUTHORIZATION_SERVICE, type AuthorizationService } from '../../contracts/authorization';
import type { Permission } from '../../contracts/permissions';
import type { Principal } from '../../contracts/principal';
import {
  PUBLIC_ROUTE,
  REQUIRE_AUTHENTICATION,
  REQUIRE_PERMISSION,
} from '../../contracts/route-access';

export interface RequestWithPrincipal extends Request {
  principal?: Principal;
}

/** RFC 6750 bearer credentials; the scheme name is case-insensitive (RFC 7235). */
const BEARER = /^Bearer[ ]+([A-Za-z0-9._~+/-]+=*)$/i;

/**
 * The single HTTP gate: authentication, then authorization, in one place and
 * in a fixed order.
 *
 *   @PublicRoute()            → allowed; no token is even looked at
 *   @Authenticated()          → a live principal is required
 *   @RequirePermission(p)     → a live principal holding p is required
 *   none of the above         → 403, for everyone — fail closed
 *
 * The guard holds no rules of its own. It reads the route's declaration, asks
 * identity's application layer who the caller is, and asks the authorization
 * service whether they may proceed. Use cases then authorize AGAIN with the
 * resource in context — this guard is the coarse check, not the only one.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolvePrincipal: ResolvePrincipalUseCase,
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets) === true) return true;

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(
      REQUIRE_PERMISSION,
      targets,
    );
    const authenticatedOnly =
      this.reflector.getAllAndOverride<boolean | undefined>(REQUIRE_AUTHENTICATION, targets) ===
      true;

    if (permission === undefined && !authenticatedOnly) {
      throw new FailureException(
        failure(
          'forbidden',
          'identity.route_undeclared',
          'This route declares no access requirement.',
        ),
      );
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = await this.authenticate(request);
    if (principal === null) {
      throw new FailureException(
        failure('unauthenticated', 'identity.authentication_required', 'Authentication required.'),
      );
    }
    request.principal = principal;

    if (permission !== undefined && !this.authorization.can(principal, permission)) {
      throw new FailureException(
        failure('forbidden', 'identity.permission_denied', 'You may not perform this action.'),
      );
    }
    return true;
  }

  private async authenticate(request: Request): Promise<Principal | null> {
    const match = BEARER.exec(request.headers.authorization ?? '');
    if (match === null || match[1] === undefined) return null;
    return this.resolvePrincipal.execute(match[1]);
  }
}

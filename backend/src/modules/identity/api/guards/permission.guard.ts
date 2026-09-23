import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AUTHORIZATION_SERVICE, type AuthorizationService, type Permission } from '../../contracts';
import { PUBLIC_ROUTE } from '../../../../platform/http/public-route.decorator';
import { REQUIRE_PERMISSION } from '../decorators/require-permission';
import type { RequestWithPrincipal } from './authentication.guard';

/**
 * Enforces the declared permission through the central authorization service.
 *
 * The guard contains no rules of its own — it reads the route's requirement and
 * asks identity. That is what keeps `if (role === 'admin')` from reappearing at
 * the edges.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets) === true) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      REQUIRE_PERMISSION,
      targets,
    );
    // Unannotated routes are refused rather than silently allowed.
    if (required === undefined) {
      throw new ForbiddenException('This route declares no permission requirement.');
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = request.principal;
    if (principal === undefined) throw new UnauthorizedException('Authentication required.');

    if (!this.authorization.can(principal, required)) {
      throw new ForbiddenException('You may not perform this action.');
    }
    return true;
  }
}

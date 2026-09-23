import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { AUTHORIZATION_SERVICE, type AuthorizationService, type Principal } from '../../contracts';

export interface RequestWithPrincipal extends Request {
  principal?: Principal;
}

interface AccessTokenClaims {
  readonly sub: string;
  readonly roles?: readonly string[];
}

/**
 * Turns a bearer token into a Principal.
 *
 * It never rejects on its own — an absent or invalid token simply leaves the
 * request anonymous. Deciding whether anonymous is acceptable is the
 * PermissionGuard's job, so there is exactly one place that denies access.
 *
 * Permissions are recomputed from roles on every request rather than read from
 * the token, so revoking a role takes effect immediately instead of when the
 * token expires.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const header = request.headers.authorization;

    if (header?.startsWith('Bearer ') === true) {
      const token = header.slice('Bearer '.length).trim();
      try {
        const claims = await this.jwt.verifyAsync<AccessTokenClaims>(token);
        request.principal = this.authorization.principalFor(claims.sub, claims.roles ?? []);
      } catch {
        // Invalid or expired token — stays anonymous.
      }
    }
    return true;
  }
}

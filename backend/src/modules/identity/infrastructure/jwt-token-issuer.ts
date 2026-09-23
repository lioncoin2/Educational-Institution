import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { APP_CONFIG } from '../../../platform/config/app-config';
import type { AppConfig } from '../../../platform/config/app-config';
import type { AccessToken, TokenIssuer } from '../domain/ports';

/**
 * JWT adapter for the TokenIssuer port.
 *
 * The token carries only identity (subject + roles). Permissions are resolved
 * per request from the current role assignment, so a revoked role takes effect
 * immediately rather than lingering until the token expires.
 */
@Injectable()
export class JwtTokenIssuer implements TokenIssuer {
  constructor(
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async issue(userId: string, roles: readonly string[]): Promise<AccessToken> {
    const expiresInSeconds = this.config.auth.accessTtlSeconds;
    const token = await this.jwt.signAsync({ sub: userId, roles }, { expiresIn: expiresInSeconds });
    return { token, expiresInSeconds };
  }
}

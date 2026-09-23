import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { CLOCK, type Clock } from '../../../shared';
import type {
  AccessToken,
  AccessTokenSubject,
  TokenIssuer,
  VerifiedAccessToken,
} from '../domain/ports';

export interface AccessTokenSettings {
  /** HMAC key. Validated for length at boot in production (platform/config). */
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
}

export const ACCESS_TOKEN_SETTINGS = Symbol('ACCESS_TOKEN_SETTINGS');

/** The one algorithm accepted. Pinned on verify so a token cannot choose its own. */
const ALGORITHM = 'HS256';

/**
 * The JWT adapter — the only file that signs or verifies an access token.
 *
 * Claims are deliberately minimal:
 *
 *   sub  opaque user id           sid  session id
 *   iat  issued at                exp  expiry
 *   iss  this API                 aud  its clients
 *
 * No email, no name, no roles, no permissions. Anything placed in a JWT is
 * readable by anyone holding it, lives in client storage and logs, and stays
 * true until expiry even after the underlying fact changes. Roles and
 * permissions are instead resolved from storage on every request.
 */
@Injectable()
export class JwtTokenIssuer implements TokenIssuer {
  constructor(
    private readonly jwt: JwtService,
    @Inject(ACCESS_TOKEN_SETTINGS) private readonly settings: AccessTokenSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async issueAccessToken(subject: AccessTokenSubject): Promise<AccessToken> {
    const token = await this.jwt.signAsync(
      { sub: subject.userId, sid: subject.sessionId, iat: this.nowSeconds() },
      {
        secret: this.settings.secret,
        algorithm: ALGORITHM,
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        expiresIn: this.settings.ttlSeconds,
      },
    );
    return { token, expiresInSeconds: this.settings.ttlSeconds };
  }

  async verifyAccessToken(token: string): Promise<VerifiedAccessToken | null> {
    try {
      const claims = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.settings.secret,
        algorithms: [ALGORITHM],
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        clockTimestamp: this.nowSeconds(),
      });
      if (
        typeof claims.sub !== 'string' ||
        typeof claims.sid !== 'string' ||
        typeof claims.exp !== 'number'
      ) {
        return null;
      }
      return { userId: claims.sub, sessionId: claims.sid, expiresAt: new Date(claims.exp * 1000) };
    } catch {
      // Expired, tampered, wrong issuer, wrong algorithm — all the same answer.
      return null;
    }
  }

  private nowSeconds(): number {
    return Math.floor(this.clock.now().getTime() / 1000);
  }
}

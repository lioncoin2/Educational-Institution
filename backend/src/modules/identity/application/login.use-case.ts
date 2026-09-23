import { Inject, Injectable } from '@nestjs/common';

import { ok, type Result } from '../../../shared';
import { TOKEN_ISSUER, type TokenIssuer } from '../domain/ports';
import { AuthenticateUseCase, type AuthenticateCommand } from './authenticate.use-case';

export interface LoginResult {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly userId: string;
  readonly roles: readonly string[];
}

/** Verifies credentials, then mints an access token for the caller. */
@Injectable()
export class LoginUseCase {
  constructor(
    private readonly authenticate: AuthenticateUseCase,
    @Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuer,
  ) {}

  async execute(command: AuthenticateCommand): Promise<Result<LoginResult>> {
    const authenticated = await this.authenticate.execute(command);
    if (!authenticated.ok) return authenticated;

    const principal = authenticated.value;
    const token = await this.tokens.issue(principal.userId, principal.roles);

    return ok({
      accessToken: token.token,
      expiresInSeconds: token.expiresInSeconds,
      userId: principal.userId,
      roles: principal.roles,
    });
  }
}

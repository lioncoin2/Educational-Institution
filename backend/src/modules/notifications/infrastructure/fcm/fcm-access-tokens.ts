import { sign } from 'node:crypto';

import type { Clock } from '../../../../shared';
import { GOOGLE_TOKEN_URI, type FcmCredentials } from './fcm-credentials';

/** The one OAuth scope sending needs — not the cloud-platform scope. */
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** An assertion asks for an hour, the most Google grants. */
const ASSERTION_LIFETIME_SECONDS = 3600;
/** A token is replaced this long before it expires, so none is used as it dies. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** A failed exchange is remembered this long: a page of sends asks once, not per send. */
const FAILURE_MEMORY_MS = 10_000;
const EXCHANGE_TIMEOUT_MS = 10_000;

/**
 * Why no token could be had: `retryable` (try later — not before
 * `retryAfterSeconds`, when the failure is remembered) or `rejected`
 * (configuration).
 */
export interface AccessTokenFailure {
  readonly kind: 'retryable' | 'rejected';
  readonly reason: string;
  readonly retryAfterSeconds?: number;
}

export type AccessTokenResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly failure: AccessTokenFailure };

export type Fetch = typeof fetch;

/**
 * OAuth 2.0 access tokens for FCM, by the service account's JWT-bearer grant
 * (RFC 7523): an RS256 assertion signed with the account's key, exchanged at
 * Google's token endpoint for a bearer token of about an hour.
 *
 * One token is shared by every send and replaced before it expires; concurrent
 * sends wait for the same exchange; a failed exchange is remembered briefly,
 * and meanwhile a token that has not expired yet is still used. Neither the
 * assertion nor the token is ever logged or put in an error.
 */
export class FcmAccessTokens {
  private current: { readonly token: string; readonly expiresAt: number } | null = null;
  private pending: Promise<AccessTokenResult> | null = null;
  private failed: { readonly failure: AccessTokenFailure; readonly until: number } | null = null;

  constructor(
    private readonly credentials: FcmCredentials,
    private readonly clock: Clock,
    private readonly fetcher: Fetch = fetch,
    private readonly tokenUri: string = GOOGLE_TOKEN_URI,
  ) {}

  /** A token that is still valid, or why there is none. */
  async get(): Promise<AccessTokenResult> {
    const now = this.clock.now().getTime();
    if (this.current !== null && now < this.current.expiresAt - REFRESH_MARGIN_MS) {
      return { ok: true, token: this.current.token };
    }
    if (this.failed !== null && now < this.failed.until) {
      return this.stillValid(now) ?? this.remembered(this.failed, now);
    }
    this.pending ??= this.exchange().finally(() => {
      this.pending = null;
    });
    const result = await this.pending;
    // Google failed to renew it: the old token is good until it expires.
    return result.ok ? result : (this.stillValid(this.clock.now().getTime()) ?? result);
  }

  private stillValid(now: number): AccessTokenResult | null {
    return this.current !== null && now < this.current.expiresAt
      ? { ok: true, token: this.current.token }
      : null;
  }

  private remembered(
    failed: { readonly failure: AccessTokenFailure; readonly until: number },
    now: number,
  ): AccessTokenResult {
    return {
      ok: false,
      failure: { ...failed.failure, retryAfterSeconds: Math.ceil((failed.until - now) / 1000) },
    };
  }

  /** FCM refused `token`: forget it, unless a newer one replaced it already. */
  invalidate(token: string): void {
    if (this.current?.token === token) this.current = null;
  }

  private async exchange(): Promise<AccessTokenResult> {
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: this.assertion(issuedAt),
    });
    let response: Response;
    try {
      response = await this.fetcher(this.tokenUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
    } catch (error) {
      return this.fail('retryable', isTimeout(error) ? 'oauth_timeout' : 'oauth_network');
    }
    if (!response.ok) {
      // 400 invalid_grant (a deleted or disabled key, a clock far off), 401
      // invalid_client: configuration, which no retry mends. Throttling and
      // Google's own failures are worth another try.
      const retryable = response.status === 429 || response.status >= 500;
      return this.fail(retryable ? 'retryable' : 'rejected', `oauth_http_${response.status}`);
    }
    let granted: { access_token?: unknown; expires_in?: unknown };
    try {
      granted = (await response.json()) as typeof granted;
    } catch {
      return this.fail('retryable', 'oauth_malformed');
    }
    const token = granted.access_token;
    const expiresIn = granted.expires_in;
    if (typeof token !== 'string' || token.length === 0 || typeof expiresIn !== 'number') {
      return this.fail('retryable', 'oauth_malformed');
    }
    this.failed = null;
    this.current = { token, expiresAt: this.clock.now().getTime() + expiresIn * 1000 };
    return { ok: true, token };
  }

  /** The signed JWT-bearer assertion: header.claims.signature, base64url. */
  private assertion(issuedAt: number): string {
    const header = { alg: 'RS256', typ: 'JWT', kid: this.credentials.privateKeyId };
    const claims = {
      iss: this.credentials.clientEmail,
      scope: FCM_SCOPE,
      aud: this.tokenUri,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
    };
    const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), this.credentials.privateKey);
    return `${unsigned}.${signature.toString('base64url')}`;
  }

  private fail(kind: AccessTokenFailure['kind'], reason: string): AccessTokenResult {
    const failure = { kind, reason };
    this.failed = { failure, until: this.clock.now().getTime() + FAILURE_MEMORY_MS };
    return { ok: false, failure: { ...failure, retryAfterSeconds: FAILURE_MEMORY_MS / 1000 } };
  }
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** `AbortSignal.timeout` rejects with a TimeoutError DOMException. */
export function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

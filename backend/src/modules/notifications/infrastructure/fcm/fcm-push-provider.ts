import { Logger } from '@nestjs/common';

import type { Clock } from '../../../../shared';
import type { PushDevice, PushMessage, PushOutcome, PushProvider } from '../../domain/push';
import {
  FcmAccessTokens,
  isTimeout,
  type AccessTokenFailure,
  type Fetch,
} from './fcm-access-tokens';
import { readServiceAccountFile, type FcmCredentials } from './fcm-credentials';
import { fcmSendRequest } from './fcm-message';
import { classifyFcmAnswer } from './fcm-outcome';

const SEND_TIMEOUT_MS = 10_000;
/** A configuration problem is logged once in this window, not once per send. */
const CONFIGURATION_LOG_WINDOW_MS = 5 * 60_000;

/** The FCM HTTP v1 endpoint that sends for `projectId`. */
export function fcmSendEndpoint(projectId: string): string {
  return `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
}

/**
 * Push through Firebase Cloud Messaging's HTTP v1 API (ADR 0058) — no SDK:
 * an OAuth token from the service account (`FcmAccessTokens`), one HTTPS POST
 * per device, and the answer classified by `classifyFcmAnswer`.
 *
 * Android only in V1: iOS would need APNs credentials in Firebase, and the web
 * a service worker, neither of which exists — so registration refuses them
 * rather than store devices that could never receive anything.
 *
 * Logs carry reasons — canonical codes — and never a token, an access token or
 * a request body.
 */
export class FcmPushProvider implements PushProvider {
  private readonly logger = new Logger('FcmPushProvider');
  private readonly loggedAt = new Map<string, number>();

  constructor(
    private readonly tokens: FcmAccessTokens,
    private readonly clock: Clock,
    private readonly endpoint: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  /** The adapter for a mounted service-account file, read and checked now — at startup. */
  static fromCredentialsFile(path: string, clock: Clock): FcmPushProvider {
    return FcmPushProvider.fromCredentials(readServiceAccountFile(path), clock);
  }

  static fromCredentials(credentials: FcmCredentials, clock: Clock): FcmPushProvider {
    return new FcmPushProvider(
      new FcmAccessTokens(credentials, clock),
      clock,
      fcmSendEndpoint(credentials.projectId),
    );
  }

  async registerDevice(device: Omit<PushDevice, 'id'>): Promise<{ readonly accepted: boolean }> {
    return { accepted: device.provider === 'FCM' && device.platform === 'ANDROID' };
  }

  async unregisterDevice(): Promise<void> {
    // FCM keeps nothing server-side to drop: the app deletes its own token.
  }

  async send(device: PushDevice, message: PushMessage): Promise<PushOutcome> {
    return this.attempt(device, message, false, false);
  }

  /**
   * FCM checks the request — credentials, project, permission, payload, token —
   * and sends nothing (`validate_only`). For the deployment smoke check.
   */
  async validate(device: PushDevice, message: PushMessage): Promise<PushOutcome> {
    return this.attempt(device, message, true, false);
  }

  /** One send; a refused access token is replaced and the send tried once more. */
  private async attempt(
    device: PushDevice,
    message: PushMessage,
    validateOnly: boolean,
    retriedAuthentication: boolean,
  ): Promise<PushOutcome> {
    if (device.provider !== 'FCM') return { kind: 'rejected', reason: 'NOT_FCM' };
    const access = await this.tokens.get();
    if (!access.ok) return this.withoutToken(access.failure);

    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${access.token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(fcmSendRequest(device, message, { validateOnly })),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      return { kind: 'retryable', reason: isTimeout(error) ? 'TIMEOUT' : 'NETWORK' };
    }
    const answer = classifyFcmAnswer(
      response.status,
      await bodyOf(response),
      response.headers.get('retry-after'),
      this.clock.now(),
    );
    if (answer.kind === 'unauthenticated') {
      this.tokens.invalidate(access.token);
      if (!retriedAuthentication) return this.attempt(device, message, validateOnly, true);
      return this.misconfigured('UNAUTHENTICATED');
    }
    if (answer.kind === 'rejected') return this.misconfigured(answer.reason);
    return answer;
  }

  private withoutToken(failure: AccessTokenFailure): PushOutcome {
    if (failure.kind === 'rejected') return this.misconfigured(failure.reason);
    // Not before the failure is forgotten: a retry sooner would meet it again.
    return failure.retryAfterSeconds === undefined
      ? { kind: 'retryable', reason: failure.reason }
      : { kind: 'retryable', reason: failure.reason, retryAfterSeconds: failure.retryAfterSeconds };
  }

  /** A rejection no retry mends: said loudly, once in a while. */
  private misconfigured(reason: string): PushOutcome {
    const now = this.clock.now().getTime();
    const last = this.loggedAt.get(reason);
    if (last === undefined || now - last >= CONFIGURATION_LOG_WINDOW_MS) {
      this.loggedAt.set(reason, now);
      this.logger.error(
        { reason },
        'FCM refused a push and no retry will help; see the push runbook (ADR 0058)',
      );
    }
    return { kind: 'rejected', reason };
  }
}

/** The answer's JSON, or null — the body is always read, so the connection is reused. */
async function bodyOf(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (response.ok || text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

import type { PushOutcome } from '../../domain/push';

const FCM_ERROR = 'type.googleapis.com/google.firebase.fcm.v1.FcmError';
const BAD_REQUEST = 'type.googleapis.com/google.rpc.BadRequest';
/** A canonical code is all a reason may carry — never the message text. */
const CODE_SHAPE = /^[A-Z][A-Z_]{0,39}$/;

/**
 * FCM's answer to one send, as the adapter reads it. `unauthenticated` is the
 * adapter's own business — its access token was refused, so it fetches a new
 * one and tries once more — and never reaches push delivery.
 */
export type FcmAnswer = PushOutcome | { readonly kind: 'unauthenticated' };

interface GoogleError {
  readonly message?: unknown;
  readonly status?: unknown;
  readonly details?: unknown;
}

/**
 * Classifies a send's HTTP answer (ADR 0058 D10). The FcmError `errorCode`
 * decides first, the HTTP status only when there is none:
 *
 *   2xx                                    delivered
 *   UNREGISTERED                           invalid_token  the app is gone, or the token aged out
 *   INVALID_ARGUMENT on `message.token`    invalid_token  not a token FCM will ever accept
 *   other INVALID_ARGUMENT                 rejected       this request is wrong — never the device
 *   SENDER_ID_MISMATCH                     rejected       the token is another project's: a
 *                                                         configuration problem, so no device
 *                                                         is switched off for it
 *   THIRD_PARTY_AUTH_ERROR                 rejected
 *   QUOTA_EXCEEDED, UNAVAILABLE, INTERNAL  retryable      honouring Retry-After
 *   401                                    unauthenticated
 *   429, 5xx                               retryable
 *   anything else (403, 404, other 4xx)    rejected       configuration: logged, never retried
 */
export function classifyFcmAnswer(
  status: number,
  body: unknown,
  retryAfter: string | null,
  now: Date,
): FcmAnswer {
  if (status >= 200 && status < 300) return { kind: 'delivered' };
  const error = googleErrorOf(body);
  const retryAfterSeconds = retryAfterSecondsOf(retryAfter, now);
  const retryable = (reason: string): PushOutcome =>
    retryAfterSeconds === undefined
      ? { kind: 'retryable', reason }
      : { kind: 'retryable', reason, retryAfterSeconds };

  switch (fcmErrorCodeOf(error)) {
    case 'UNREGISTERED':
      return { kind: 'invalid_token', reason: 'UNREGISTERED' };
    case 'INVALID_ARGUMENT':
      return namesTheToken(error)
        ? { kind: 'invalid_token', reason: 'INVALID_TOKEN' }
        : { kind: 'rejected', reason: 'INVALID_ARGUMENT' };
    case 'SENDER_ID_MISMATCH':
      return { kind: 'rejected', reason: 'SENDER_ID_MISMATCH' };
    case 'THIRD_PARTY_AUTH_ERROR':
      return { kind: 'rejected', reason: 'THIRD_PARTY_AUTH_ERROR' };
    case 'QUOTA_EXCEEDED':
      return retryable('QUOTA_EXCEEDED');
    case 'UNAVAILABLE':
      return retryable('UNAVAILABLE');
    case 'INTERNAL':
      return retryable('INTERNAL');
    default:
      break;
  }
  if (status === 401) return { kind: 'unauthenticated' };
  if (status === 429 || status >= 500) return retryable(`HTTP_${status}`);
  if (status === 400 && namesTheToken(error)) {
    return { kind: 'invalid_token', reason: 'INVALID_TOKEN' };
  }
  const code = error?.status;
  return {
    kind: 'rejected',
    reason: typeof code === 'string' && CODE_SHAPE.test(code) ? code : `HTTP_${status}`,
  };
}

function googleErrorOf(body: unknown): GoogleError | null {
  const error = (body as { error?: unknown } | null)?.error;
  return error !== null && typeof error === 'object' ? error : null;
}

function detailsOf(error: GoogleError | null): readonly Record<string, unknown>[] {
  const details = error?.details;
  if (!Array.isArray(details)) return [];
  return details.filter(
    (detail): detail is Record<string, unknown> => detail !== null && typeof detail === 'object',
  );
}

function fcmErrorCodeOf(error: GoogleError | null): string | null {
  for (const detail of detailsOf(error)) {
    if (detail['@type'] === FCM_ERROR && typeof detail.errorCode === 'string') {
      return detail.errorCode;
    }
  }
  return null;
}

/** INVALID_ARGUMENT about the registration token itself, not the rest of the request. */
function namesTheToken(error: GoogleError | null): boolean {
  for (const detail of detailsOf(error)) {
    if (detail['@type'] !== BAD_REQUEST || !Array.isArray(detail.fieldViolations)) continue;
    for (const violation of detail.fieldViolations as unknown[]) {
      if ((violation as { field?: unknown } | null)?.field === 'message.token') return true;
    }
  }
  const message = error?.message;
  return typeof message === 'string' && /not a valid FCM registration token/i.test(message);
}

/**
 * `Retry-After` as seconds from now: a number of seconds, or an HTTP date.
 * Undefined when absent or unreadable — the backoff then decides alone.
 */
export function retryAfterSecondsOf(header: string | null, now: Date): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d{1,6}$/.test(value)) return Number(value);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

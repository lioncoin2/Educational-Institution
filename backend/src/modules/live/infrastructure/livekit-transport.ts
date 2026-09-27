import { ServerError, type ClientOptions } from 'livekit-server-sdk';

/**
 * How the LiveKit adapter talks to the server over HTTP, and how it reads a
 * failure — shared by the room service and the readiness probe.
 *
 * The SDK writes one line of its own, past the adapter's logger:
 * `console.debug` of the parse error when an error answer is labelled JSON
 * and is not (SDK `TwirpRPC.ts`, `toTwirpError`). That error quotes at most
 * ten characters of the body on each side of where parsing failed: never a
 * whole token a server echoed back, and never the secret, which no request
 * carries.
 */

/** Every server call waits this long, then fails as an outage (the SDK's default, stated). */
export const LIVEKIT_REQUEST_TIMEOUT_SECONDS = 10;

/**
 * The room service's options, stated rather than defaulted, so an SDK
 * upgrade cannot change them: one attempt, bounded by the timeout. Region
 * failover exists for LiveKit Cloud hosts only, and a self-hosted server has
 * no other region to retry against.
 */
export const LIVEKIT_CLIENT_OPTIONS: Readonly<ClientOptions> = Object.freeze({
  requestTimeout: LIVEKIT_REQUEST_TIMEOUT_SECONDS,
  failover: false,
});

/**
 * A failed call, by what the caller can do about it:
 *
 *   not_found      LiveKit itself said so: Twirp's `not_found` code on a 404,
 *                  which LiveKit writes as JSON for a room or a participant
 *                  it does not have. The only failure that may mean absence.
 *   unavailable    an outage: nothing answered (refused, reset, unresolvable,
 *                  timed out), or a 5xx — LiveKit, or the proxy in front of
 *                  it, could not serve
 *   misconfigured  our credentials were refused: 401, 403, `unauthenticated`
 *                  or `permission_denied`
 *   tls            the TLS handshake or the certificate failed: a URL or a
 *                  certificate is wrong
 *   incompatible   something answered that is not LiveKit: a 404 without its
 *                  `not_found` (a proxy's page, a wrong path, `bad_route`), a
 *                  4xx or 2xx body that is not its JSON, or not HTTP at all
 *   rejected       LiveKit refused the request itself (a 4xx it coded)
 */
export type LiveKitFailure =
  'not_found' | 'unavailable' | 'misconfigured' | 'tls' | 'incompatible' | 'rejected';

/**
 * Node's certificate verification codes (`tls`, "X509 certificate error
 * codes") and its TLS and OpenSSL failures, as the platform's fetch reports
 * them in the `cause` of its `TypeError`.
 */
const TLS_FAILURE =
  /^(ERR_TLS_|ERR_SSL_|CERT_|CRL_|UNABLE_TO_|ERROR_IN_CERT|ERROR_IN_CRL|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|INVALID_CA$|INVALID_PURPOSE$|PATH_LENGTH_EXCEEDED$|HOSTNAME_MISMATCH$|EPROTO$)/;

/** Connection-level failures: nothing, or nothing whole, came back. */
const TRANSPORT_FAILURE =
  /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR)/;

/** The shapes of an error's class, of a platform error code and of a Twirp code — never free text. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TWIRP_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Sorts a failure. The SDK throws its own `ServerError` for any non-2xx
 * answer (with `code` only when the body was Twirp's JSON), the platform's
 * fetch errors when nothing usable answered — a `TypeError` whose `cause`
 * carries the code, a `TimeoutError` — and a `SyntaxError` for a 2xx body
 * that is not JSON. The platform's errors are read by their name and code,
 * never by `instanceof`: its fetch may throw another realm's error classes.
 */
export function classify(error: unknown): LiveKitFailure {
  if (error instanceof ServerError) {
    const code = typeof error.code === 'string' ? error.code : undefined;
    // Only LiveKit's own answer means "not there": anything else that says
    // 404 is a wrong endpoint, never an absent room or participant.
    if (error.status === 404) return code === 'not_found' ? 'not_found' : 'incompatible';
    if (error.status === 401 || error.status === 403) return 'misconfigured';
    if (code === 'unauthenticated' || code === 'permission_denied') return 'misconfigured';
    if (error.status >= 500 || code === 'unavailable' || code === 'deadline_exceeded') {
      return 'unavailable';
    }
    return code === undefined ? 'incompatible' : 'rejected';
  }
  const failure = thrown(error);
  if (failure === null) return 'rejected';
  const code = errorCode(failure);
  if (code !== undefined && TLS_FAILURE.test(code)) return 'tls';
  // The platform's HTTP parser: the peer does not speak HTTP/1.1.
  if (code !== undefined && code.startsWith('HPE_')) return 'incompatible';
  const name = failure.name;
  if (name === 'SyntaxError') return 'incompatible';
  if (name === 'TypeError' || name === 'AbortError' || name === 'TimeoutError')
    return 'unavailable';
  if (code !== undefined && TRANSPORT_FAILURE.test(code)) return 'unavailable';
  return 'rejected';
}

/**
 * What of an error may be logged: its class, the HTTP status and Twirp code
 * if there was an answer, and the platform's code if there was none. Never
 * the message — a provider message, or a proxy's page, could echo a request
 * — and so never a token, a JWT or the secret.
 */
export function describe(error: unknown): { name: string; status?: number; code?: string } {
  if (error instanceof ServerError) {
    return {
      name: 'ServerError',
      status: error.status,
      ...(typeof error.code === 'string' && TWIRP_CODE.test(error.code)
        ? { code: error.code }
        : {}),
    };
  }
  const failure = thrown(error);
  if (failure === null) return { name: typeof error };
  const code = errorCode(failure);
  return {
    name: ERROR_NAME.test(failure.name) ? failure.name : 'Error',
    ...(code === undefined ? {} : { code }),
  };
}

/** Something thrown with a name — an error of this realm or another. */
interface Thrown {
  readonly name: string;
  readonly code?: unknown;
  readonly cause?: unknown;
}

function thrown(value: unknown): Thrown | null {
  if (typeof value !== 'object' || value === null) return null;
  return typeof (value as { name?: unknown }).name === 'string' ? (value as Thrown) : null;
}

/** The platform's code of a failure — its own, or its cause's — when it has the shape of one. */
function errorCode(failure: Thrown): string | undefined {
  for (const candidate of [failure.cause, failure]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && ERROR_CODE.test(code)) return code;
  }
  return undefined;
}

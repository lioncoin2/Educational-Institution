import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import type { Fetch } from '../../src/modules/notifications/infrastructure/fcm/fcm-access-tokens';

/**
 * Test material for the FCM adapter: a real RSA key generated per process (so
 * a signed assertion can be verified, never a committed key), a service
 * account around it, a scripted `fetch`, and FCM's error answers in the shape
 * the HTTP v1 API returns them (google.rpc.Status with FcmError details).
 */
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const TEST_PUBLIC_KEY: KeyObject = keys.publicKey;
export const TEST_PRIVATE_KEY_PEM = keys.privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

export const TEST_PROJECT_ID = 'quran-institution-test';
export const TEST_CLIENT_EMAIL = `fcm-sender@${TEST_PROJECT_ID}.iam.gserviceaccount.com`;
export const TEST_PRIVATE_KEY_ID = '0123456789abcdef0123456789abcdef01234567';

/** A service-account file as Google issues it; `overrides` replace or (undefined) drop fields. */
export function serviceAccountJson(overrides: Record<string, unknown> = {}): string {
  const account: Record<string, unknown> = {
    type: 'service_account',
    project_id: TEST_PROJECT_ID,
    private_key_id: TEST_PRIVATE_KEY_ID,
    private_key: TEST_PRIVATE_KEY_PEM,
    client_email: TEST_CLIENT_EMAIL,
    client_id: '100000000000000000000',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete account[key];
  }
  return JSON.stringify(account);
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8', ...headers },
  });
}

type Answer = Response | Error | (() => Response | Promise<Response>);

/** A `fetch` that records each request and answers from a script (then 200 `{}`). */
export class ScriptedFetch {
  readonly calls: { readonly url: string; readonly init: RequestInit }[] = [];
  private readonly answers: Answer[] = [];

  respond(...answers: Answer[]): this {
    this.answers.push(...answers);
    return this;
  }

  readonly fetch: Fetch = async (url, init) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    this.calls.push({ url: target, init: init ?? {} });
    const next = this.answers.shift() ?? json(200, {});
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };

  /** The JSON body of the n-th request. */
  bodyOf(n: number): unknown {
    const body = this.calls[n]?.init.body;
    return JSON.parse(typeof body === 'string' ? body : 'null');
  }
}

/** Google's token endpoint granting `token` for an hour. */
export function granted(token = 'ya29.test-access-token', expiresIn = 3599): Response {
  return json(200, { access_token: token, expires_in: expiresIn, token_type: 'Bearer' });
}

const FCM_ERROR = 'type.googleapis.com/google.firebase.fcm.v1.FcmError';
const BAD_REQUEST = 'type.googleapis.com/google.rpc.BadRequest';

function status(code: number, name: string, message: string, details?: unknown[]) {
  return { error: { code, message, status: name, ...(details ? { details } : {}) } };
}

/** FCM HTTP v1 error answers, by what they mean. */
export const FCM_ANSWERS = {
  unregistered: () =>
    json(
      404,
      status(404, 'NOT_FOUND', 'Requested entity was not found.', [
        { '@type': FCM_ERROR, errorCode: 'UNREGISTERED' },
      ]),
    ),
  notAToken: () =>
    json(
      400,
      status(
        400,
        'INVALID_ARGUMENT',
        'The registration token is not a valid FCM registration token',
        [
          { '@type': FCM_ERROR, errorCode: 'INVALID_ARGUMENT' },
          {
            '@type': BAD_REQUEST,
            fieldViolations: [
              {
                field: 'message.token',
                description: 'The registration token is not a valid FCM registration token',
              },
            ],
          },
        ],
      ),
    ),
  badPayload: () =>
    json(
      400,
      status(400, 'INVALID_ARGUMENT', "Invalid value at 'message.android.ttl'", [
        { '@type': FCM_ERROR, errorCode: 'INVALID_ARGUMENT' },
        {
          '@type': BAD_REQUEST,
          fieldViolations: [{ field: 'message.android.ttl', description: 'Invalid value' }],
        },
      ]),
    ),
  senderIdMismatch: () =>
    json(
      403,
      status(403, 'PERMISSION_DENIED', 'SenderId mismatch', [
        { '@type': FCM_ERROR, errorCode: 'SENDER_ID_MISMATCH' },
      ]),
    ),
  permissionDenied: () =>
    json(
      403,
      status(
        403,
        'PERMISSION_DENIED',
        "Permission 'cloudmessaging.messages.create' denied on resource",
        [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'IAM_PERMISSION_DENIED' }],
      ),
    ),
  projectNotFound: () => json(404, status(404, 'NOT_FOUND', 'Requested entity was not found.')),
  unauthenticated: () =>
    json(401, status(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.')),
  thirdPartyAuth: () =>
    json(
      401,
      status(401, 'UNAUTHENTICATED', 'Auth error from APNS or Web Push Service', [
        { '@type': FCM_ERROR, errorCode: 'THIRD_PARTY_AUTH_ERROR' },
      ]),
    ),
  quotaExceeded: (retryAfter = '30') =>
    json(
      429,
      status(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded.', [
        { '@type': FCM_ERROR, errorCode: 'QUOTA_EXCEEDED' },
      ]),
      { 'retry-after': retryAfter },
    ),
  unavailable: (retryAfter?: string) =>
    json(
      503,
      status(503, 'UNAVAILABLE', 'The service is currently unavailable.', [
        { '@type': FCM_ERROR, errorCode: 'UNAVAILABLE' },
      ]),
      retryAfter === undefined ? {} : { 'retry-after': retryAfter },
    ),
  internal: () =>
    json(
      500,
      status(500, 'INTERNAL', 'Internal error encountered.', [
        { '@type': FCM_ERROR, errorCode: 'INTERNAL' },
      ]),
    ),
  gatewayHtml: () =>
    new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }),
};

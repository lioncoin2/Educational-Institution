import { FCM_ANSWERS } from '../../../../../test/support/fcm-fixtures';
import { classifyFcmAnswer, retryAfterSecondsOf } from './fcm-outcome';

const NOW = new Date('2026-11-08T08:00:00.000Z');

async function classify(response: Response) {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return classifyFcmAnswer(response.status, body, response.headers.get('retry-after'), NOW);
}

describe('classifying FCM’s answer (ADR 0058, D10)', () => {
  it('is delivered on a 2xx', async () => {
    expect(classifyFcmAnswer(200, null, null, NOW)).toEqual({ kind: 'delivered' });
  });

  it.each([
    [
      'UNREGISTERED: the app is gone',
      FCM_ANSWERS.unregistered,
      { kind: 'invalid_token', reason: 'UNREGISTERED' },
    ],
    [
      'INVALID_ARGUMENT on message.token',
      FCM_ANSWERS.notAToken,
      { kind: 'invalid_token', reason: 'INVALID_TOKEN' },
    ],
  ])('switches the device off for %s', async (_case, answer, outcome) => {
    expect(await classify(answer())).toEqual(outcome);
  });

  // These would otherwise switch off EVERY device for one server mistake.
  it.each([
    [
      'another INVALID_ARGUMENT — this request is wrong, not the device',
      FCM_ANSWERS.badPayload,
      'INVALID_ARGUMENT',
    ],
    [
      'SENDER_ID_MISMATCH — the token is another project’s',
      FCM_ANSWERS.senderIdMismatch,
      'SENDER_ID_MISMATCH',
    ],
    [
      '403 PERMISSION_DENIED — the service account may not send',
      FCM_ANSWERS.permissionDenied,
      'PERMISSION_DENIED',
    ],
    ['404 without UNREGISTERED — no such project', FCM_ANSWERS.projectNotFound, 'NOT_FOUND'],
    [
      'THIRD_PARTY_AUTH_ERROR — even though it is a 401',
      FCM_ANSWERS.thirdPartyAuth,
      'THIRD_PARTY_AUTH_ERROR',
    ],
  ])('rejects, keeping the device, on %s', async (_case, answer, reason) => {
    expect(await classify(answer())).toEqual({ kind: 'rejected', reason });
  });

  it('hands a refused access token back to the adapter', async () => {
    expect(await classify(FCM_ANSWERS.unauthenticated())).toEqual({ kind: 'unauthenticated' });
  });

  it.each([
    [
      'QUOTA_EXCEEDED, honouring Retry-After seconds',
      FCM_ANSWERS.quotaExceeded('30'),
      { kind: 'retryable', reason: 'QUOTA_EXCEEDED', retryAfterSeconds: 30 },
    ],
    [
      'UNAVAILABLE, honouring a Retry-After date',
      FCM_ANSWERS.unavailable('Sun, 08 Nov 2026 08:00:12 GMT'),
      { kind: 'retryable', reason: 'UNAVAILABLE', retryAfterSeconds: 12 },
    ],
    ['INTERNAL', FCM_ANSWERS.internal(), { kind: 'retryable', reason: 'INTERNAL' }],
    ['a gateway’s HTML page', FCM_ANSWERS.gatewayHtml(), { kind: 'retryable', reason: 'HTTP_502' }],
  ])('retries %s', async (_case, response, outcome) => {
    expect(await classify(response)).toEqual(outcome);
  });

  it('carries codes only — never FCM’s message text', async () => {
    expect(JSON.stringify(await classify(FCM_ANSWERS.permissionDenied()))).not.toContain(
      'cloudmessaging',
    );
    expect(classifyFcmAnswer(418, { error: { status: 'not a code!' } }, null, NOW)).toEqual({
      kind: 'rejected',
      reason: 'HTTP_418',
    });
  });

  it('reads Retry-After as seconds or an HTTP date, and ignores what it cannot read', () => {
    expect(retryAfterSecondsOf('120', NOW)).toBe(120);
    expect(retryAfterSecondsOf('Sun, 08 Nov 2026 08:01:00 GMT', NOW)).toBe(60);
    expect(retryAfterSecondsOf('Sun, 08 Nov 2026 07:00:00 GMT', NOW)).toBe(0);
    expect(retryAfterSecondsOf('soon', NOW)).toBeUndefined();
    expect(retryAfterSecondsOf(null, NOW)).toBeUndefined();
  });
});

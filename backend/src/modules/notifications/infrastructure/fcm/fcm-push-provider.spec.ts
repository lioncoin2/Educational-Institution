import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';

import {
  FCM_ANSWERS,
  ScriptedFetch,
  TEST_PROJECT_ID,
  granted,
  json,
  serviceAccountJson,
} from '../../../../../test/support/fcm-fixtures';
import { AdjustableClock } from '../../../../../test/support/identity-harness';
import { asId } from '../../../../shared';
import { pushMessageFor, type PushDevice, type PushMessage } from '../../domain/push';
import { FcmAccessTokens } from './fcm-access-tokens';
import { FcmCredentialsError, parseServiceAccount } from './fcm-credentials';
import { fcmSendRequest } from './fcm-message';
import { FcmPushProvider, fcmSendEndpoint } from './fcm-push-provider';

const DEVICE: PushDevice = {
  id: 'device-1',
  platform: 'ANDROID',
  provider: 'FCM',
  token: 'fcm-token-0001:APA91bxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
};

const MESSAGE: PushMessage = pushMessageFor({
  id: asId<'Notification'>('n-1'),
  recipientUserId: 'u-1',
  type: 'MESSAGE_RECEIVED',
  category: 'MESSAGES',
  titleKey: 'notification.message_received.title',
  bodyKey: 'notification.message_received.body',
  params: {},
  target: { kind: 'conversation', conversationId: 'c-1' },
  dedupeKey: 'k',
  createdAt: new Date('2026-11-08T08:00:00.000Z'),
  readAt: null,
});

describe('the FCM push provider', () => {
  const credentials = parseServiceAccount(serviceAccountJson());
  let clock: AdjustableClock;
  let google: ScriptedFetch;
  let fcm: ScriptedFetch;
  let provider: FcmPushProvider;
  let errors: unknown[];

  beforeEach(() => {
    clock = new AdjustableClock();
    google = new ScriptedFetch();
    fcm = new ScriptedFetch();
    provider = new FcmPushProvider(
      new FcmAccessTokens(credentials, clock, google.fetch),
      clock,
      fcmSendEndpoint(TEST_PROJECT_ID),
      fcm.fetch,
    );
    errors = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('posts one request per device to the project’s v1 endpoint, with the bearer token', async () => {
    google.respond(granted('ya29.token'));
    fcm.respond(json(200, { name: `projects/${TEST_PROJECT_ID}/messages/0:1` }));

    expect(await provider.send(DEVICE, MESSAGE)).toEqual({ kind: 'delivered' });

    expect(fcm.calls).toHaveLength(1);
    expect(fcm.calls[0]?.url).toBe(
      `https://fcm.googleapis.com/v1/projects/${TEST_PROJECT_ID}/messages:send`,
    );
    expect(fcm.calls[0]?.init.method).toBe('POST');
    expect(fcm.calls[0]?.init.headers).toEqual({
      authorization: 'Bearer ya29.token',
      'content-type': 'application/json; charset=utf-8',
    });
    expect(fcm.bodyOf(0)).toEqual(fcmSendRequest(DEVICE, MESSAGE));
  });

  it('validates without sending when asked', async () => {
    google.respond(granted());
    await provider.validate(DEVICE, MESSAGE);
    expect(fcm.bodyOf(0)).toMatchObject({ validate_only: true });
  });

  it('replaces a refused access token and tries once more', async () => {
    google.respond(granted('ya29.stale'), granted('ya29.fresh'));
    fcm.respond(FCM_ANSWERS.unauthenticated(), json(200, {}));

    expect(await provider.send(DEVICE, MESSAGE)).toEqual({ kind: 'delivered' });
    expect(google.calls).toHaveLength(2);
    expect(
      fcm.calls.map((call) => (call.init.headers as Record<string, string>).authorization),
    ).toEqual(['Bearer ya29.stale', 'Bearer ya29.fresh']);
  });

  it('gives up after one fresh token is refused too — a configuration problem, said once', async () => {
    google.respond(granted('ya29.a'), granted('ya29.b'));
    fcm.respond(FCM_ANSWERS.unauthenticated(), FCM_ANSWERS.unauthenticated());
    expect(await provider.send(DEVICE, MESSAGE)).toEqual({
      kind: 'rejected',
      reason: 'UNAUTHENTICATED',
    });
    expect(fcm.calls).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });

  it('does not chase a new token for THIRD_PARTY_AUTH_ERROR, although it is a 401', async () => {
    google.respond(granted());
    fcm.respond(FCM_ANSWERS.thirdPartyAuth());
    expect(await provider.send(DEVICE, MESSAGE)).toEqual({
      kind: 'rejected',
      reason: 'THIRD_PARTY_AUTH_ERROR',
    });
    expect(google.calls).toHaveLength(1);
    expect(fcm.calls).toHaveLength(1);
  });

  it('passes on what FCM said about the token, and retries what is transient', async () => {
    google.respond(granted());
    fcm.respond(
      FCM_ANSWERS.unregistered(),
      FCM_ANSWERS.quotaExceeded('7'),
      new TypeError('fetch failed'),
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    );
    expect(await provider.send(DEVICE, MESSAGE)).toEqual({
      kind: 'invalid_token',
      reason: 'UNREGISTERED',
    });
    expect(await provider.send(DEVICE, MESSAGE)).toEqual({
      kind: 'retryable',
      reason: 'QUOTA_EXCEEDED',
      retryAfterSeconds: 7,
    });
    expect(await provider.send(DEVICE, MESSAGE)).toEqual({ kind: 'retryable', reason: 'NETWORK' });
    expect(await provider.send(DEVICE, MESSAGE)).toEqual({ kind: 'retryable', reason: 'TIMEOUT' });
  });

  it('sends nothing without an access token: retryable when Google is down, rejected when refused', async () => {
    google.respond(json(503, {}));
    expect(await provider.send(DEVICE, MESSAGE)).toEqual({
      kind: 'retryable',
      reason: 'oauth_http_503',
      // Not before Google's failure is forgotten: a sooner retry would meet it again.
      retryAfterSeconds: 10,
    });
    clock.advance(10);
    google.respond(json(400, { error: 'invalid_grant' }));
    expect(await provider.send(DEVICE, MESSAGE)).toEqual({
      kind: 'rejected',
      reason: 'oauth_http_400',
    });
    expect(fcm.calls).toEqual([]);
  });

  it('logs a configuration problem once in five minutes — and never a token', async () => {
    google.respond(granted('ya29.secret-access-token'));
    fcm.respond(
      FCM_ANSWERS.senderIdMismatch(),
      FCM_ANSWERS.senderIdMismatch(),
      FCM_ANSWERS.senderIdMismatch(),
    );
    await provider.send(DEVICE, MESSAGE);
    await provider.send(DEVICE, MESSAGE);
    expect(errors).toHaveLength(1);
    clock.advance(5 * 60);
    await provider.send(DEVICE, MESSAGE);
    expect(errors).toHaveLength(2);
    const logged = JSON.stringify(errors);
    expect(logged).toContain('SENDER_ID_MISMATCH');
    expect(logged).not.toContain(DEVICE.token);
    expect(logged).not.toContain('ya29.secret-access-token');
  });

  it('accepts Android FCM devices only — nothing could reach iOS or the web yet', async () => {
    expect(
      await provider.registerDevice({ platform: 'ANDROID', provider: 'FCM', token: 't' }),
    ).toEqual({
      accepted: true,
    });
    expect(await provider.registerDevice({ platform: 'WEB', provider: 'FCM', token: 't' })).toEqual(
      {
        accepted: false,
      },
    );
    expect(
      await provider.registerDevice({ platform: 'IOS', provider: 'APNS', token: 't' }),
    ).toEqual({
      accepted: false,
    });
    expect(await provider.send({ ...DEVICE, platform: 'IOS', provider: 'APNS' }, MESSAGE)).toEqual({
      kind: 'rejected',
      reason: 'NOT_FCM',
    });
  });

  it('is built from the mounted credentials file — and refuses one it cannot use, at startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcm-provider-'));
    const good = join(dir, 'good.json');
    writeFileSync(good, serviceAccountJson(), { mode: 0o400 });
    expect(FcmPushProvider.fromCredentialsFile(good, clock)).toBeInstanceOf(FcmPushProvider);
    expect(() => FcmPushProvider.fromCredentialsFile(join(dir, 'absent.json'), clock)).toThrow(
      FcmCredentialsError,
    );
  });
});

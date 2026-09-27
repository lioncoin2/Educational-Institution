import { Logger } from '@nestjs/common';

import { AdjustableClock } from '../../../../test/support/identity-harness';
import { credentialsIn, serialize } from '../../../../test/support/log-capture';
import {
  startStubHttpServer,
  type StubAnswer,
  type StubHttpServer,
  type StubRequest,
} from '../../../../test/support/stub-http-server';
import { loadConfig } from '../../../platform/config/app-config';
import { PINNED_LIVEKIT_SERVER_VERSION } from '../../../platform/config/livekit-config';
import { LiveMediaReadiness } from '../application/live-media-readiness';
import { ROOM_SWEEP_SECONDS } from '../domain/live-limits';
import type { RtcCapabilities } from '../domain/rtc-provider';
import { LiveKitRtcProvider } from './livekit-rtc-provider';

const SECRET = 'a-redaction-spec-secret-that-must-never-be-written-anywhere';
const TURN_PASSWORD = 'turn-password-that-must-never-be-written';

const SPEAKER: RtcCapabilities = {
  canPublishAudio: true,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
};

/**
 * What a hostile or misconfigured endpoint answers: `status`, with a body
 * that echoes the request — its Authorization header and its body — back.
 */
const echoing =
  (status: number, contentType = 'text/plain') =>
  (request: StubRequest): StubAnswer => ({
    status,
    contentType,
    body: `refused ${String(request.headers.authorization)} for ${request.body}`,
  });

/**
 * Nothing sensitive is logged, whatever the provider answers (P7.1, decision
 * 4): the real adapter and the readiness it feeds, against a server that
 * echoes every credential it is sent back into its answers — every answer
 * the adapter classifies, the readiness probe's included. Everything logged
 * through the logger or straight to the console (the SDK's own lines
 * included), every error thrown and every readiness report is serialized in
 * full and scanned — whatever key it sits under — for the secret, a JWT
 * (`eyJ`), an Authorization value (`Bearer`), and every token actually sent
 * or issued.
 */
describe('what the LiveKit adapter writes, against a server that echoes credentials', () => {
  let stub: StubHttpServer;
  let written: unknown[];

  beforeAll(async () => {
    stub = await startStubHttpServer();
  });

  afterAll(async () => {
    await stub.close();
  });

  beforeEach(() => {
    written = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        written.push({ level, args });
      });
    }
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        written.push({ console: level, args });
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('writes no secret, token or Authorization value anywhere', async () => {
    const clock = new AdjustableClock(new Date('2026-09-27T09:00:00.000Z'));
    const rtc = new LiveKitRtcProvider(
      loadConfig({
        NODE_ENV: 'test',
        LIVE_MEDIA_PROVIDER: 'livekit',
        LIVE_ROOM_NAME_PREFIX: 'live-spec-',
        LIVEKIT_URL: 'ws://127.0.0.1:7880',
        LIVEKIT_API_URL: stub.url,
        LIVEKIT_VERSION: PINNED_LIVEKIT_SERVER_VERSION,
        LIVEKIT_API_KEY: 'APIredactionspec',
        LIVEKIT_API_SECRET: SECRET,
      }),
    );
    const readiness = new LiveMediaReadiness(rtc, clock);
    const issued = await rtc.issueAccessToken({
      roomName: 'live-spec-room',
      identity: 'student-1',
      displayName: 'مريم',
      capabilities: SPEAKER,
      ttlSeconds: 120,
    });

    /** Every call of the adapter, and one readiness check, against the answers set. */
    async function everything(): Promise<void> {
      const calls: Array<() => Promise<unknown>> = [
        () =>
          rtc.ensureRoom({
            roomName: 'live-spec-room',
            maxParticipants: 310,
            emptyTimeoutSeconds: 1_200,
            departureTimeoutSeconds: 1_200,
          }),
        () => rtc.endRoom('live-spec-room'),
        () => rtc.listRooms(),
        () => rtc.getParticipant('live-spec-room', 'student-1'),
        () => rtc.listParticipants('live-spec-room'),
        () => rtc.updateCapabilities('live-spec-room', 'student-1', SPEAKER),
        () => rtc.removeParticipant('live-spec-room', 'student-1'),
        () => rtc.muteParticipant('live-spec-room', 'student-1', ['microphone']),
      ];
      for (const call of calls) {
        try {
          written.push({ outcome: await call() });
        } catch (error) {
          written.push({ thrown: error });
        }
      }
      clock.advance(ROOM_SWEEP_SECONDS);
      written.push({ readiness: await readiness.ensureFresh(ROOM_SWEEP_SECONDS * 1000) });
    }

    // The room API refusing, echoing, in every way the adapter tells apart.
    for (const answer of [
      echoing(401),
      echoing(403, 'text/html'),
      echoing(404),
      echoing(404, 'text/html'),
      echoing(500),
      echoing(503, 'application/json'),
      echoing(200, 'text/html'),
    ]) {
      stub.answer(answer);
      await everything();
    }
    // The room API answering — rooms with their TURN password — and
    // `/rtc/validate` echoing, whatever it says.
    for (const validate of [echoing(200), echoing(401), echoing(404), echoing(302)]) {
      stub.answer((request) =>
        request.url.startsWith('/twirp/')
          ? {
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                rooms: [
                  { name: 'live-spec-room', numParticipants: 1, turnPassword: TURN_PASSWORD },
                ],
                name: 'live-spec-room',
                turnPassword: TURN_PASSWORD,
              }),
            }
          : validate(request),
      );
      await everything();
    }

    // Not vacuous: credentials were sent, echoed back, and the scenario ran.
    const sent = stub.requests.map((request) => String(request.headers.authorization));
    expect(sent.length).toBeGreaterThan(80);
    expect(sent.every((value) => /^Bearer eyJ/.test(value))).toBe(true);
    expect(stub.requests.some((request) => request.url === '/rtc/validate')).toBe(true);
    const text = serialize(written);
    expect(text).toContain('live.provider.error');
    expect(text).toContain('live.provider.health_check');
    expect(text).toContain('live.provider.token_issue');
    expect(text).toContain('live.provider.room_create');
    expect(text).toContain('The media provider refused');
    // …the SDK's own console line included (an error answer labelled JSON that is not).
    expect(text).toContain('Error when trying to parse error message');

    // The scan: nothing sensitive, under any key.
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TURN_PASSWORD);
    expect(text).not.toContain('eyJ');
    expect(text).not.toContain('Bearer');
    expect(credentialsIn(text)).toEqual([]);
    for (const token of [issued.token, ...sent.map((value) => value.slice('Bearer '.length))]) {
      expect(text).not.toContain(token);
    }
  });

  // The SDK writes one line of its own, past the adapter: `console.debug` of
  // the parse error when an error answer is labelled JSON and is not. The
  // platform's parse error quotes ten characters of the body on each side of
  // where it failed — for a body that is a token, its fixed header
  // (`{"alg":"HS256"`) and nothing of its claims or signature. No request
  // carries the secret.
  it('lets the SDK quote no more of an echoed token than its fixed header', async () => {
    const rtc = new LiveKitRtcProvider(
      loadConfig({
        NODE_ENV: 'test',
        LIVE_MEDIA_PROVIDER: 'livekit',
        LIVE_ROOM_NAME_PREFIX: 'live-spec-',
        LIVEKIT_URL: 'ws://127.0.0.1:7880',
        LIVEKIT_API_URL: stub.url,
        LIVEKIT_VERSION: PINNED_LIVEKIT_SERVER_VERSION,
        LIVEKIT_API_KEY: 'APIredactionspec',
        LIVEKIT_API_SECRET: SECRET,
      }),
    );
    stub.answer((request) => ({
      status: 401,
      contentType: 'application/json',
      body: String(request.headers.authorization).slice('Bearer '.length),
    }));
    await expect(rtc.listRooms()).rejects.toThrow('The media provider refused listRooms (401).');
    const token = String(stub.requests[stub.requests.length - 1]?.headers.authorization).slice(
      'Bearer '.length,
    );
    const [header, claims, signature] = token.split('.');
    const text = serialize(written);
    // Not vacuous: the SDK did write its line, quoting the body.
    expect(text).toContain('Error when trying to parse error message');
    expect(text).toContain(token.slice(0, 10));
    expect(header).toBe('eyJhbGciOiJIUzI1NiJ9');
    expect(text).not.toContain(token.slice(0, 11));
    expect(text).not.toContain(claims);
    expect(text).not.toContain(signature);
    expect(text).not.toContain(SECRET);
    expect(credentialsIn(text)).toEqual([]);
  });
});

import { Logger } from '@nestjs/common';
import { ServerError, TokenVerifier } from 'livekit-server-sdk';

import { loadConfig, type AppConfig } from '../../../platform/config/app-config';
import { PINNED_LIVEKIT_SERVER_VERSION } from '../../../platform/config/livekit-config';
import { parseMediaRoomName } from '../domain/live-session';
import type { RtcReadinessReport } from '../domain/rtc-provider';
import {
  LIVEKIT_ROOM_NOT_FOUND_BODY,
  LiveKitReadiness,
  READINESS_PROBE_IDENTITY,
} from './livekit-readiness';

const KEY = 'APIreadinessspec';
const SECRET = 'a-readiness-spec-secret-long-enough-for-hs256';
const PREFIX = 'live-school-a-';

/** Real media as configuration makes it, the server API on a private address. */
const CONFIG: AppConfig = loadConfig({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app@db/institution',
  REDIS_URL: 'redis://cache:6379',
  JWT_SECRET: 'j'.repeat(48),
  STORAGE_SIGNING_SECRET: 'k'.repeat(48),
  LIVE_MEDIA_PROVIDER: 'livekit',
  LIVE_ROOM_NAME_PREFIX: PREFIX,
  LIVEKIT_URL: 'wss://media.school.example',
  LIVEKIT_API_URL: 'http://livekit:7880',
  LIVEKIT_VERSION: PINNED_LIVEKIT_SERVER_VERSION,
  LIVEKIT_API_KEY: KEY,
  LIVEKIT_API_SECRET: SECRET,
});

/** The configuration with other URLs or another environment — what boot checks would refuse, say. */
function configWith(
  livekit: Partial<AppConfig['livekit']>,
  nodeEnv: AppConfig['nodeEnv'] = CONFIG.nodeEnv,
): AppConfig {
  return { ...CONFIG, nodeEnv, livekit: { ...CONFIG.livekit, ...livekit } };
}

/** An answer of `/rtc/validate`. */
const answer = (status: number, body: string) => async () => new Response(body, { status });

/** Node's fetch failing with `code`, as it does. */
function fetchFailure(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

function timeout(): Error {
  return Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
  });
}

interface Probe {
  readonly readiness: LiveKitReadiness;
  readonly rooms: { readonly listRooms: jest.Mock };
  readonly http: jest.Mock;
}

/** The probe over a room lister and an HTTP client that answer as told. */
function probe(
  options: {
    readonly config?: AppConfig;
    readonly listRooms?: () => Promise<never[]>;
    readonly validate?: () => Promise<Response>;
  } = {},
): Probe {
  const rooms = { listRooms: jest.fn(options.listRooms ?? (async () => [])) };
  const http = jest.fn(options.validate ?? answer(404, LIVEKIT_ROOM_NOT_FOUND_BODY));
  const readiness = new LiveKitReadiness(options.config ?? CONFIG, rooms, http);
  return { readiness, rooms, http };
}

const notReady = (reason: string): RtcReadinessReport =>
  ({ ready: false, reason }) as RtcReadinessReport;

describe('the LiveKit readiness probe (live.md §9; P7.1)', () => {
  let logged: jest.SpyInstance[];

  beforeEach(() => {
    logged = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });

  afterEach(() => {
    // The probe logs nothing itself: the application logs each transition.
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('is ready when the room API accepts our credentials and LiveKit says the probe room does not exist', async () => {
    const { readiness } = probe();
    await expect(readiness.check()).resolves.toEqual({ ready: true });
  });

  describe('the request it makes', () => {
    it('lists, then validates, one fresh room of this deployment’s form that no session can have', async () => {
      const { readiness, rooms, http } = probe();
      await readiness.check();
      await readiness.check();
      const [[first], [second]] = rooms.listRooms.mock.calls as [string[]][];
      expect(first).toHaveLength(1);
      const [room] = first;
      expect(room).toMatch(
        /^live-school-a-readiness-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(parseMediaRoomName(PREFIX, room)).toBeNull();
      expect(second).not.toEqual(first);
      expect(http).toHaveBeenCalledTimes(2);
    });

    it('asks /rtc/validate on the server API, the token in the Authorization header only', async () => {
      const { readiness, http } = probe();
      await readiness.check();
      const [url, init] = http.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe('http://livekit:7880/rtc/validate');
      expect(url.search).toBe('');
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const headers = init.headers as Record<string, string>;
      expect(Object.keys(headers)).toEqual(['Authorization']);
      expect(headers.Authorization).toMatch(/^Bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/);
    });

    it('signs a join-only token with the API secret: one room, nothing to publish, subscribe or send, 30 seconds', async () => {
      const { readiness, rooms, http } = probe();
      await readiness.check();
      const [room] = (rooms.listRooms.mock.calls[0] as [string[]])[0];
      const token = (
        (http.mock.calls[0] as [URL, RequestInit])[1].headers as Record<string, string>
      ).Authorization.replace('Bearer ', '');
      const claims = await new TokenVerifier(KEY, SECRET).verify(token);
      expect(claims).toMatchObject({ iss: KEY, sub: READINESS_PROBE_IDENTITY });
      expect(claims.video).toStrictEqual({
        room,
        roomJoin: true,
        canPublish: false,
        canPublishSources: [],
        canSubscribe: false,
        canPublishData: false,
        canUpdateOwnMetadata: false,
      });
      const { exp, nbf } = claims as { exp: number; nbf: number };
      expect(exp - nbf).toBe(30);
    });
  });

  describe('1. an insecure URL in a deployed environment — decided before any request', () => {
    it.each<[string, AppConfig]>([
      ['a ws:// client URL in production', configWith({ url: 'ws://media.school.example' })],
      [
        'a ws:// client URL in staging',
        configWith({ url: 'ws://media.school.example' }, 'staging'),
      ],
      [
        'an http:// API URL to a public host',
        configWith({ apiUrl: 'http://media.school.example' }),
      ],
    ])('reports %s as insecure_url, and sends nothing', async (_case, config) => {
      const { readiness, rooms, http } = probe({ config });
      await expect(readiness.check()).resolves.toEqual(notReady('insecure_url'));
      expect(rooms.listRooms).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
    });

    it('lets development use ws:// and plain http to a public host', async () => {
      const config = configWith(
        { url: 'ws://media.school.example', apiUrl: 'http://media.school.example' },
        'development',
      );
      await expect(probe({ config }).readiness.check()).resolves.toEqual({ ready: true });
    });
  });

  describe('2. the room API, with the API credentials', () => {
    it.each<[string, unknown, string]>([
      ['a 401 for a wrong secret', new ServerError('Unauthorized', 'x', 401), 'unauthorized'],
      [
        'Twirp’s unauthenticated',
        new ServerError('Unauthorized', 'x', 401, 'unauthenticated'),
        'unauthorized',
      ],
      ['a proxy’s 403', new ServerError('Forbidden', 'x', 403), 'unauthorized'],
      ['a codeless 404', new ServerError('Not Found', 'x', 404), 'incompatible_response'],
      [
        'a Twirp bad_route',
        new ServerError('Not Found', 'x', 404, 'bad_route'),
        'incompatible_response',
      ],
      [
        'a 4xx LiveKit coded',
        new ServerError('Bad Request', 'x', 400, 'invalid_argument'),
        'incompatible_response',
      ],
      ['a body that is not JSON', new SyntaxError('Unexpected token <'), 'incompatible_response'],
      ['a proxy’s 502', new ServerError('Bad Gateway', 'x', 502), 'unreachable'],
      ['LiveKit’s 503', new ServerError('Unavailable', 'x', 503, 'unavailable'), 'unreachable'],
      ['a refused connection', fetchFailure('ECONNREFUSED'), 'unreachable'],
      ['an unresolvable host', fetchFailure('ENOTFOUND'), 'unreachable'],
      ['a timeout', timeout(), 'unreachable'],
      ['a self-signed certificate', fetchFailure('DEPTH_ZERO_SELF_SIGNED_CERT'), 'tls_failure'],
      ['an expired certificate', fetchFailure('CERT_HAS_EXPIRED'), 'tls_failure'],
      [
        'a certificate for another host',
        fetchFailure('ERR_TLS_CERT_ALTNAME_INVALID'),
        'tls_failure',
      ],
      ['TLS to a plain port', fetchFailure('ERR_SSL_WRONG_VERSION_NUMBER'), 'tls_failure'],
      ['a peer that is not HTTP', fetchFailure('HPE_INVALID_CONSTANT'), 'incompatible_response'],
      ['something thrown that is no error', 'a string', 'incompatible_response'],
    ])('reports %s as %s, and validates nothing', async (_case, failure, reason) => {
      const { readiness, http } = probe({
        listRooms: async () => {
          throw failure;
        },
      });
      await expect(readiness.check()).resolves.toEqual(notReady(reason));
      expect(http).not.toHaveBeenCalled();
    });
  });

  describe('3. /rtc/validate: only LiveKit’s own answers count', () => {
    it.each<[string, number, string, RtcReadinessReport]>([
      ['LiveKit’s 404 for a missing room', 404, LIVEKIT_ROOM_NOT_FOUND_BODY, { ready: true }],
      ['a 200 success', 200, 'success', notReady('auto_create_enabled')],
      ['a wrong secret’s 401', 401, 'invalid authorization token', notReady('unauthorized')],
      ['a 401 with no body', 401, '', notReady('unauthorized')],
      ['a codeless 404', 404, '404 page not found', notReady('incompatible_response')],
      ['a proxy’s HTML 404', 404, '<h1>Not Found</h1>', notReady('incompatible_response')],
      ['an empty 404', 404, '', notReady('incompatible_response')],
      [
        'LiveKit’s body with a newline',
        404,
        `${LIVEKIT_ROOM_NOT_FOUND_BODY}\n`,
        notReady('incompatible_response'),
      ],
      [
        'LiveKit’s words in a JSON body',
        404,
        JSON.stringify({ error: LIVEKIT_ROOM_NOT_FOUND_BODY }),
        notReady('incompatible_response'),
      ],
      ['a 200 that is not success', 200, 'OK', notReady('incompatible_response')],
      ['an empty 200', 200, '', notReady('incompatible_response')],
      ['a 200 proxy page', 200, '<html>Welcome</html>', notReady('incompatible_response')],
      ['a 403', 403, 'Forbidden', notReady('incompatible_response')],
      ['a 400', 400, 'join_request is required', notReady('incompatible_response')],
      ['a 500', 500, 'could not validate', notReady('incompatible_response')],
      ['a 503', 503, 'limit exceeded', notReady('incompatible_response')],
      ['a redirect', 302, '', notReady('incompatible_response')],
    ])('reads %s', async (_case, status, body, report) => {
      await expect(probe({ validate: answer(status, body) }).readiness.check()).resolves.toEqual(
        report,
      );
    });

    it.each<[string, unknown, string]>([
      ['a refused connection', fetchFailure('ECONNREFUSED'), 'unreachable'],
      ['a timeout', timeout(), 'unreachable'],
      ['a reset', fetchFailure('UND_ERR_SOCKET'), 'unreachable'],
      ['a certificate failure', fetchFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'tls_failure'],
      ['a peer that is not HTTP', fetchFailure('HPE_INVALID_CONSTANT'), 'incompatible_response'],
    ])('reads %s on the way as %s', async (_case, failure, reason) => {
      const validate = async (): Promise<Response> => {
        throw failure;
      };
      await expect(probe({ validate }).readiness.check()).resolves.toEqual(notReady(reason));
    });

    it('reads a body cut off on the way as unreachable', async () => {
      const validate = async (): Promise<Response> =>
        ({
          status: 404,
          text: () => Promise.reject(fetchFailure('UND_ERR_SOCKET')),
        }) as unknown as Response;
      await expect(probe({ validate }).readiness.check()).resolves.toEqual(notReady('unreachable'));
    });
  });
});

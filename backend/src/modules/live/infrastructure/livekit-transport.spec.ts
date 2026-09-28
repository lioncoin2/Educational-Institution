import { RoomServiceClient, ServerError } from 'livekit-server-sdk';

import {
  closedPort,
  startStubHttpServer,
  type StubAnswer,
  type StubHttpServer,
} from '../../../../test/support/stub-http-server';
import {
  LIVEKIT_CLIENT_OPTIONS,
  classify,
  describe as describeError,
  outageOf,
} from './livekit-transport';

const KEY = 'APItransportspec';
const SECRET = 'a-transport-spec-secret-that-is-long-enough';

/** Node's fetch failing with `code`, as it does: a TypeError whose cause carries it. */
function fetchFailure(code: string, message = `failed: ${code}`): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
}

/**
 * The error the real SDK throws for one room-service call answered as
 * `answer` — the classification is tested on what the SDK really produces
 * for each kind of answer, not on a hand-made copy of it.
 */
async function sdkFailure(stub: StubHttpServer, answer: StubAnswer): Promise<unknown> {
  stub.answer(answer);
  const rooms = new RoomServiceClient(stub.url, KEY, SECRET, LIVEKIT_CLIENT_OPTIONS);
  try {
    await rooms.getParticipant('live-room', 'student-1');
  } catch (error) {
    return error;
  }
  throw new Error('the call succeeded');
}

describe('the LiveKit transport', () => {
  let stub: StubHttpServer;

  beforeAll(async () => {
    stub = await startStubHttpServer();
  });

  afterAll(async () => {
    await stub.close();
  });

  it('states the SDK’s client options: a 10-second timeout, and never a failover', () => {
    expect(LIVEKIT_CLIENT_OPTIONS).toEqual({ requestTimeout: 10, failover: false });
    expect(Object.isFrozen(LIVEKIT_CLIENT_OPTIONS)).toBe(true);
  });

  describe('a 404 means "not found" only when LiveKit says so (audit S1)', () => {
    it('reads LiveKit’s own not_found — Twirp JSON, as the server writes it — as not found', async () => {
      const error = await sdkFailure(stub, {
        status: 404,
        contentType: 'application/json',
        body: '{"code":"not_found","msg":"twirp error unknown: participant does not exist"}',
      });
      expect(error).toBeInstanceOf(ServerError);
      expect(classify(error)).toBe('not_found');
    });

    it.each<[string, StubAnswer]>([
      ['a codeless plain-text 404', { status: 404, body: '404 page not found' }],
      [
        'a proxy’s HTML 404',
        { status: 404, contentType: 'text/html', body: '<html><h1>404 Not Found</h1></html>' },
      ],
      [
        'a JSON 404 without a code',
        { status: 404, contentType: 'application/json', body: '{"error":"no such route"}' },
      ],
      [
        'a Twirp bad_route — a path this server does not serve',
        {
          status: 404,
          contentType: 'application/json',
          body: '{"code":"bad_route","msg":"no handler for path"}',
        },
      ],
      ['an empty 404', { status: 404 }],
    ])('reads %s as an incompatible answer — never as not found', async (_case, answer) => {
      expect(classify(await sdkFailure(stub, answer))).toBe('incompatible');
    });

    it('never reads not_found on another status as not found', () => {
      expect(classify(new ServerError('Gone', 'x', 410, 'not_found'))).toBe('rejected');
      expect(classify(new ServerError('Bad Gateway', 'x', 502, 'not_found'))).toBe('unavailable');
    });
  });

  describe('every other answer', () => {
    it('reads a 2xx body that is not JSON as incompatible', async () => {
      const error = await sdkFailure(stub, {
        status: 200,
        contentType: 'text/html',
        body: '<html>Welcome to nginx!</html>',
      });
      // The platform's own SyntaxError — of another realm than this test's.
      expect(error).toMatchObject({ name: 'SyntaxError' });
      expect(classify(error)).toBe('incompatible');
    });

    it('reads a 2xx JSON body that is not a LiveKit message as a fault', async () => {
      const error = await sdkFailure(stub, {
        status: 200,
        contentType: 'application/json',
        body: '{"identity":{"not":"a string"}}',
      });
      expect(classify(error)).toBe('rejected');
    });

    it.each<[string, StubAnswer]>([
      [
        'LiveKit’s 401 for a wrong secret',
        {
          status: 401,
          body: 'invalid authorization token: token signature is invalid: signature is invalid',
        },
      ],
      ['a 401 for an unknown key', { status: 401, body: 'invalid API key' }],
      [
        'Twirp’s unauthenticated',
        {
          status: 401,
          contentType: 'application/json',
          body: '{"code":"unauthenticated","msg":"permissions denied"}',
        },
      ],
      ['a proxy’s 403', { status: 403, contentType: 'text/html', body: '<h1>Forbidden</h1>' }],
    ])('reads %s as misconfigured credentials', async (_case, answer) => {
      expect(classify(await sdkFailure(stub, answer))).toBe('misconfigured');
    });

    it.each<[string, StubAnswer, string]>([
      ['a 500', { status: 500, body: 'internal error' }, 'server_error'],
      [
        'a proxy’s 502',
        { status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' },
        'server_error',
      ],
      [
        'LiveKit’s 503 unavailable',
        {
          status: 503,
          contentType: 'application/json',
          body: '{"code":"unavailable","msg":"no response from servers"}',
        },
        'server_error',
      ],
      ['a 504', { status: 504, body: 'gateway timeout' }, 'timeout'],
      [
        'LiveKit’s deadline_exceeded',
        {
          status: 503,
          contentType: 'application/json',
          body: '{"code":"deadline_exceeded","msg":"deadline exceeded"}',
        },
        'timeout',
      ],
    ])('reads %s as an outage, and says which (P7.2, Q-B)', async (_case, answer, outage) => {
      const error = await sdkFailure(stub, answer);
      expect(classify(error)).toBe('unavailable');
      expect(outageOf(error)).toBe(outage);
    });

    it('reads a 4xx LiveKit coded itself as a refusal', async () => {
      const error = await sdkFailure(stub, {
        status: 400,
        contentType: 'application/json',
        body: '{"code":"invalid_argument","msg":"room name length exceeds limits"}',
      });
      expect(classify(error)).toBe('rejected');
      expect(classify(await sdkFailure(stub, { status: 400, body: 'bad request' }))).toBe(
        'incompatible',
      );
    });
  });

  describe('no usable answer at all', () => {
    it('reads a refused connection as an outage', async () => {
      const rooms = new RoomServiceClient(
        `http://127.0.0.1:${await closedPort()}`,
        KEY,
        SECRET,
        LIVEKIT_CLIENT_OPTIONS,
      );
      const error = await rooms.listRooms().catch((failure: unknown) => failure);
      expect(describeError(error)).toEqual({ name: 'TypeError', code: 'ECONNREFUSED' });
      expect(classify(error)).toBe('unavailable');
      expect(outageOf(error)).toBe('unreachable');
    });

    it('reads a connection reset mid-request as an outage', async () => {
      const error = await sdkFailure(stub, 'reset');
      expect(describeError(error)).toEqual({ name: 'TypeError', code: 'UND_ERR_SOCKET' });
      expect(classify(error)).toBe('unavailable');
      expect(outageOf(error)).toBe('unreachable');
    });

    it('reads a server that never answers as an outage, once the timeout passes', async () => {
      stub.answer('no_answer');
      const rooms = new RoomServiceClient(stub.url, KEY, SECRET, {
        ...LIVEKIT_CLIENT_OPTIONS,
        requestTimeout: 1,
      });
      const error = await rooms.listRooms().catch((failure: unknown) => failure);
      expect(describeError(error)).toEqual({ name: 'TimeoutError' });
      expect(classify(error)).toBe('unavailable');
      // Told apart from an outage for the logs only (P7.2, Q-B).
      expect(outageOf(error)).toBe('timeout');
    });

    it.each([
      ['ENOTFOUND', 'unreachable'],
      ['EAI_AGAIN', 'unreachable'],
      ['EHOSTUNREACH', 'unreachable'],
      ['ETIMEDOUT', 'timeout'],
      ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
      ['UND_ERR_HEADERS_TIMEOUT', 'timeout'],
    ])('reads %s as an outage — %s', (code, outage) => {
      expect(classify(fetchFailure(code, `getaddrinfo ${code} media.invalid`))).toBe('unavailable');
      expect(outageOf(fetchFailure(code))).toBe(outage);
    });

    it('reads TLS to a server that does not speak it as a TLS failure — never an outage', async () => {
      const rooms = new RoomServiceClient(
        `https://127.0.0.1:${stub.port}`,
        KEY,
        SECRET,
        LIVEKIT_CLIENT_OPTIONS,
      );
      const error = await rooms.listRooms().catch((failure: unknown) => failure);
      expect(describeError(error)).toMatchObject({
        name: 'TypeError',
        code: expect.stringMatching(/^ERR_SSL_/) as string,
      });
      expect(classify(error)).toBe('tls');
    });

    it.each([
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'ERR_SSL_WRONG_VERSION_NUMBER',
      'EPROTO',
    ])('reads the certificate or TLS failure %s as a TLS failure', (code) => {
      expect(classify(fetchFailure(code))).toBe('tls');
    });

    it('reads a peer that does not speak HTTP as incompatible', () => {
      expect(classify(fetchFailure('HPE_INVALID_CONSTANT'))).toBe('incompatible');
    });

    it('leaves anything else a fault, never absence and never an outage', () => {
      expect(classify(new Error('something else'))).toBe('rejected');
      expect(classify('a string')).toBe('rejected');
      expect(classify(undefined)).toBe('rejected');
    });
  });

  describe('what may be logged of a failure', () => {
    it('is its class, and the status and code an answer carried — never its message', async () => {
      const echoed = `Bearer eyJhbGciOiJIUzI1NiJ9.${SECRET}.sig`;
      const error = await sdkFailure(stub, { status: 401, body: echoed });
      const described = describeError(error);
      expect(described).toEqual({ name: 'ServerError', status: 401 });
      expect(JSON.stringify(described)).not.toContain(SECRET);
    });

    it('carries a code only in the shape of one — never text an answer made up', () => {
      expect(describeError(new ServerError('Not Found', 'x', 404, 'not_found'))).toEqual({
        name: 'ServerError',
        status: 404,
        code: 'not_found',
      });
      expect(describeError(new ServerError('Not Found', 'x', 404, `secret ${SECRET}`))).toEqual({
        name: 'ServerError',
        status: 404,
      });
      expect(describeError(fetchFailure(`X ${SECRET}`))).toEqual({ name: 'TypeError' });
      expect(describeError(fetchFailure('ECONNREFUSED', `connect ${SECRET}`))).toEqual({
        name: 'TypeError',
        code: 'ECONNREFUSED',
      });
      expect(describeError(42)).toEqual({ name: 'number' });
    });
  });
});

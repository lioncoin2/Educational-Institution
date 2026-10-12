import {
  DEFAULT_COMMUNITY_TITLE,
  type HttpClient,
  type ParticipantConfig,
  type ProvisionConfig,
  ProvisionError,
  provisionLiveSession,
  provisionParticipant,
  redactedSummary,
} from './provision-live-session';

const CONFIG: ProvisionConfig = {
  baseUrl: 'http://stack.test',
  ownerEmail: 'owner@institution.test',
  ownerPassword: 'super-secret-password',
};

const TOKEN = 'header.payload.signature-access-token';

interface Call {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
}

interface Scripted {
  status: number;
  body: Record<string, unknown>;
}

/** A recording fake HTTP seam: it answers the three known endpoints from an
 * optional script (healthy defaults otherwise) and records every call so the
 * test can assert the request shapes without a server. */
function fakeHttp(
  script: {
    login?: Scripted;
    community?: Scripted;
    live?: Scripted;
  } = {},
): { http: HttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const http: HttpClient = async (method, path, options = {}) => {
    calls.push({ method, path, token: options.token, body: options.body });
    if (path === '/auth/login') {
      return script.login ?? { status: 200, body: { accessToken: TOKEN } };
    }
    if (path === '/communities') {
      return script.community ?? { status: 201, body: { id: 'community-1' } };
    }
    if (/^\/live\/communities\/[^/]+\/sessions$/.test(path)) {
      return script.live ?? { status: 201, body: { id: 'session-1', state: 'live' } };
    }
    throw new Error(`unexpected path in test: ${path}`);
  };
  return { http, calls };
}

async function expectProvisionError(
  promise: Promise<unknown>,
  stage: ProvisionError['stage'],
): Promise<ProvisionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProvisionError);
    const provisionError = error as ProvisionError;
    expect(provisionError.stage).toBe(stage);
    return provisionError;
  }
  throw new Error(`expected a ProvisionError at stage "${stage}", none thrown`);
}

describe('provisionLiveSession', () => {
  describe('the happy path', () => {
    it('logs in, creates a community, starts a live session', async () => {
      const { http } = fakeHttp();
      const result = await provisionLiveSession(CONFIG, http);
      expect(result).toEqual({
        accessToken: TOKEN,
        communityId: 'community-1',
        sessionId: 'session-1',
      });
    });

    it('calls the three endpoints in order with the right shapes', async () => {
      const { http, calls } = fakeHttp();
      await provisionLiveSession(CONFIG, http);

      expect(calls).toHaveLength(3);

      // 1) login — public, no token, identifier+password body.
      expect(calls[0]).toMatchObject({ method: 'POST', path: '/auth/login' });
      expect(calls[0].token).toBeUndefined();
      expect(calls[0].body).toEqual({
        identifier: CONFIG.ownerEmail,
        password: CONFIG.ownerPassword,
      });

      // 2) community — bearer the token from login, title in the body.
      expect(calls[1]).toMatchObject({ method: 'POST', path: '/communities' });
      expect(calls[1].token).toBe(TOKEN);
      expect(calls[1].body).toEqual({ title: DEFAULT_COMMUNITY_TITLE });

      // 3) live start — nested under the new community id, token, no body.
      expect(calls[2]).toMatchObject({
        method: 'POST',
        path: '/live/communities/community-1/sessions',
      });
      expect(calls[2].token).toBe(TOKEN);
      expect(calls[2].body).toBeUndefined();
    });

    it('accepts 200 (not only 201) for community and live start', async () => {
      const { http } = fakeHttp({
        community: { status: 200, body: { id: 'community-1' } },
        live: { status: 200, body: { id: 'session-1', state: 'live' } },
      });
      const result = await provisionLiveSession(CONFIG, http);
      expect(result.sessionId).toBe('session-1');
    });

    it('uses a provided community title and url-encodes the community id', async () => {
      const { http, calls } = fakeHttp({
        community: { status: 201, body: { id: 'c/with space' } },
      });
      await provisionLiveSession({ ...CONFIG, communityTitle: 'My Title' }, http);
      expect(calls[1].body).toEqual({ title: 'My Title' });
      expect(calls[2].path).toBe('/live/communities/c%2Fwith%20space/sessions');
    });

    it('is deterministic — same input yields the same output', async () => {
      const first = await provisionLiveSession(CONFIG, fakeHttp().http);
      const second = await provisionLiveSession(CONFIG, fakeHttp().http);
      expect(first).toEqual(second);
    });
  });

  describe('non-2xx responses fail at the right stage', () => {
    it('surfaces a login rejection as the login stage', async () => {
      const { http, calls } = fakeHttp({
        login: { status: 401, body: { message: 'invalid credentials' } },
      });
      const error = await expectProvisionError(provisionLiveSession(CONFIG, http), 'login');
      expect(error.status).toBe(401);
      // It stops at login — community/live are never attempted.
      expect(calls).toHaveLength(1);
    });

    it('surfaces a forbidden community as the community stage', async () => {
      const { http } = fakeHttp({
        community: { status: 403, body: { message: 'forbidden' } },
      });
      const error = await expectProvisionError(provisionLiveSession(CONFIG, http), 'community');
      expect(error.status).toBe(403);
    });

    it('surfaces a failed live start as the live stage, hinting at LiveKit', async () => {
      const { http } = fakeHttp({
        live: { status: 503, body: { message: 'unavailable' } },
      });
      const error = await expectProvisionError(provisionLiveSession(CONFIG, http), 'live');
      expect(error.status).toBe(503);
      expect(error.message).toContain('LiveKit');
    });
  });

  describe('malformed success responses are rejected', () => {
    it('rejects a login response missing accessToken', async () => {
      const { http } = fakeHttp({ login: { status: 200, body: {} } });
      const error = await expectProvisionError(provisionLiveSession(CONFIG, http), 'malformed');
      expect(error.message).toContain('accessToken');
    });

    it('rejects a non-string accessToken', async () => {
      const { http } = fakeHttp({
        login: { status: 200, body: { accessToken: 12345 } },
      });
      await expectProvisionError(provisionLiveSession(CONFIG, http), 'malformed');
    });

    it('rejects a community response missing id', async () => {
      const { http } = fakeHttp({
        community: { status: 201, body: { name: 'x' } },
      });
      const error = await expectProvisionError(provisionLiveSession(CONFIG, http), 'malformed');
      expect(error.message).toContain('id');
    });

    it('rejects a live response missing id', async () => {
      const { http } = fakeHttp({
        live: { status: 201, body: { state: 'live' } },
      });
      await expectProvisionError(provisionLiveSession(CONFIG, http), 'malformed');
    });

    it('rejects a live session that is not in the live state', async () => {
      const { http } = fakeHttp({
        live: { status: 201, body: { id: 'session-1', state: 'ended' } },
      });
      const error = await expectProvisionError(provisionLiveSession(CONFIG, http), 'live');
      expect(error.message).toContain('live');
    });
  });

  describe('secret hygiene', () => {
    it('never puts the password or token in a thrown error', async () => {
      // Fail at each stage and assert no secret ever rides along in the message.
      const scripts: Array<{ login?: Scripted; community?: Scripted; live?: Scripted }> = [
        { login: { status: 401, body: { token: TOKEN } } },
        { community: { status: 500, body: {} } },
        { live: { status: 500, body: {} } },
      ];
      for (const script of scripts) {
        const { http } = fakeHttp(script);
        try {
          await provisionLiveSession(CONFIG, http);
          throw new Error('expected a failure');
        } catch (error) {
          const text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
          expect(text).not.toContain(CONFIG.ownerPassword);
          expect(text).not.toContain(TOKEN);
        }
      }
    });

    it('redactedSummary carries the ids but never the token', () => {
      const summary = redactedSummary({
        accessToken: TOKEN,
        sessionId: 'session-1',
        communityId: 'community-1',
      });
      expect(summary).toEqual({
        communityId: 'community-1',
        sessionId: 'session-1',
        accessToken: '<redacted>',
      });
      expect(JSON.stringify(summary)).not.toContain(TOKEN);
    });

    it('the orchestrator itself logs nothing', async () => {
      const spies = [
        jest.spyOn(console, 'log').mockImplementation(() => undefined),
        jest.spyOn(console, 'info').mockImplementation(() => undefined),
        jest.spyOn(console, 'warn').mockImplementation(() => undefined),
        jest.spyOn(console, 'error').mockImplementation(() => undefined),
      ];
      try {
        await provisionLiveSession(CONFIG, fakeHttp().http);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });
});

describe('provisionParticipant', () => {
  const PARTICIPANT: ParticipantConfig = {
    displayName: 'E2E Participant B',
    email: 'participant-b@e2e.test',
    password: 'participant-b-secret-password',
  };
  const TOKEN_B = 'header.payload.participant-access-token';

  /** A recording fake for the admin + auth endpoints `provisionParticipant`
   * drives; healthy defaults, with narrow overrides for the failure cases. */
  function fakeParticipantHttp(
    overrides: { createStatus?: number; createBody?: Record<string, unknown> } = {},
  ): { http: HttpClient; calls: Call[] } {
    const calls: Call[] = [];
    const http: HttpClient = async (method, path, options = {}) => {
      calls.push({ method, path, token: options.token, body: options.body });
      if (path === '/admin/users') {
        return {
          status: overrides.createStatus ?? 201,
          body: overrides.createBody ?? { id: 'user-b' },
        };
      }
      if (/^\/admin\/users\/[^/]+\/roles$/.test(path)) return { status: 200, body: {} };
      if (/^\/admin\/users\/[^/]+\/status$/.test(path)) return { status: 204, body: {} };
      if (/^\/communities\/[^/]+\/members$/.test(path)) return { status: 201, body: {} };
      if (path === '/auth/login') return { status: 200, body: { accessToken: TOKEN_B } };
      if (/^\/live\/sessions\/[^/]+\/hand$/.test(path)) {
        return { status: 201, body: { request: { id: 'request-1' } } };
      }
      if (/^\/live\/requests\/[^/]+\/grant$/.test(path)) return { status: 200, body: {} };
      throw new Error(`unexpected path in test: ${path}`);
    };
    return { http, calls };
  }

  it('creates, grants STUDENT, activates, adds, logs in, then raises+grants the floor', async () => {
    const { http, calls } = fakeParticipantHttp();
    const result = await provisionParticipant(http, {
      ownerToken: TOKEN,
      communityId: 'community-1',
      sessionId: 'session-1',
      participant: PARTICIPANT,
    });

    expect(result).toEqual({ accessToken: TOKEN_B, userId: 'user-b' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /admin/users',
      'POST /admin/users/user-b/roles',
      'POST /admin/users/user-b/status',
      'POST /communities/community-1/members',
      'POST /auth/login',
      'POST /live/sessions/session-1/hand',
      'POST /live/requests/request-1/grant',
    ]);
    // The admin calls bearer the OWNER token; login is public.
    expect(calls[0].token).toBe(TOKEN);
    expect(calls[0].body).toEqual({
      displayName: PARTICIPANT.displayName,
      identifier: PARTICIPANT.email,
      initialPassword: PARTICIPANT.password,
    });
    expect(calls[1].body).toEqual({ role: 'STUDENT' });
    expect(calls[2].body).toEqual({ status: 'ACTIVE' });
    expect(calls[3].body).toEqual({ userIds: ['user-b'] });
    expect(calls[4].token).toBeUndefined();
    expect(calls[4].body).toEqual({
      identifier: PARTICIPANT.email,
      password: PARTICIPANT.password,
    });
    // The participant raises their OWN hand; the owner grants the floor.
    expect(calls[5].token).toBe(TOKEN_B);
    expect(calls[6].token).toBe(TOKEN);
  });

  it('url-encodes the created user id in the role/status paths', async () => {
    const { http, calls } = fakeParticipantHttp({ createBody: { id: 'u/b x' } });
    await provisionParticipant(http, {
      ownerToken: TOKEN,
      communityId: 'c-1',
      sessionId: 'session-1',
      participant: PARTICIPANT,
    });
    expect(calls[1].path).toBe('/admin/users/u%2Fb%20x/roles');
    expect(calls[2].path).toBe('/admin/users/u%2Fb%20x/status');
  });

  it('fails at the participant stage when account creation is refused', async () => {
    const { http } = fakeParticipantHttp({ createStatus: 403 });
    const error = await expectProvisionError(
      provisionParticipant(http, {
        ownerToken: TOKEN,
        communityId: 'c-1',
        sessionId: 'session-1',
        participant: PARTICIPANT,
      }),
      'participant',
    );
    expect(error.status).toBe(403);
  });

  it('rejects a create response missing the user id', async () => {
    const { http } = fakeParticipantHttp({ createBody: { name: 'x' } });
    const error = await expectProvisionError(
      provisionParticipant(http, {
        ownerToken: TOKEN,
        communityId: 'c-1',
        sessionId: 'session-1',
        participant: PARTICIPANT,
      }),
      'malformed',
    );
    expect(error.message).toContain('id');
  });

  it('never puts the participant password or token in a thrown error', async () => {
    const { http } = fakeParticipantHttp({ createStatus: 500 });
    try {
      await provisionParticipant(http, {
        ownerToken: TOKEN,
        communityId: 'c-1',
        sessionId: 'session-1',
        participant: PARTICIPANT,
      });
      throw new Error('expected a failure');
    } catch (error) {
      const text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
      expect(text).not.toContain(PARTICIPANT.password);
      expect(text).not.toContain(TOKEN_B);
    }
  });
});

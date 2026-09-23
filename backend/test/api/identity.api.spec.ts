import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { startApi, type RunningApi } from '../support/api-client';

const OWNER = { email: 'owner@institution.test', password: 'owner passphrase one' };
const STUDENT = { email: 'student@institution.test', password: 'student passphrase' };

const errorOf = (body: Record<string, unknown>) => body.error as { code: string; message: string };

describe('identity API', () => {
  let api: RunningApi;
  let ownerToken: string;

  beforeAll(async () => {
    api = await startApi();
    const bootstrapped = await api.app.get(BootstrapOwnerUseCase).execute({
      displayName: 'Owner',
      identifierKind: 'email',
      identifier: OWNER.email,
      password: OWNER.password,
      meta: {},
    });
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.code);
    const login = await api.call('POST', '/auth/login', {
      body: {
        identifier: OWNER.email,
        password: OWNER.password,
        device: { platform: 'web', label: 'Admin desk' },
      },
    });
    ownerToken = login.body.accessToken as string;
  }, 60_000);

  afterAll(async () => {
    await api.close();
  });

  describe('401 — not authenticated', () => {
    it.each([
      ['no Authorization header', {}],
      ['a garbage token', { authorization: 'Bearer not-a-jwt' }],
      ['the wrong scheme', { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` }],
      ['an empty bearer', { authorization: 'Bearer ' }],
    ])('refuses %s', async (_label, headers) => {
      const response = await api.call('GET', '/auth/me', { headers });
      expect(response.status).toBe(401);
      expect(errorOf(response.body).code).toBe('identity.authentication_required');
    });

    it('refuses an admin route the same way', async () => {
      expect((await api.call('GET', '/admin/users')).status).toBe(401);
    });
  });

  describe('400 — validation', () => {
    it('rejects a login with missing fields, listing each problem', async () => {
      const response = await api.call('POST', '/auth/login', { body: { identifier: OWNER.email } });
      expect(response.status).toBe(400);
      expect(errorOf(response.body).code).toBe('bad_request');
      expect(
        (response.body.error as { details: { issues: string[] } }).details.issues.join(' '),
      ).toMatch(/password/);
    });

    it('rejects fields the contract does not declare', async () => {
      const response = await api.call('POST', '/auth/login', {
        body: { identifier: OWNER.email, password: OWNER.password, isAdmin: true },
      });
      expect(response.status).toBe(400);
      expect(response.raw).toContain('isAdmin');
    });

    it('rejects an unknown account status', async () => {
      const response = await api.call('POST', '/admin/users/any/status', {
        token: ownerToken,
        body: { status: 'GRADUATED' },
      });
      expect(response.status).toBe(400);
    });

    // A policy check on login would confirm the policy to a guesser.
    it('answers a too-short password on login with 401, not with the policy', async () => {
      const response = await api.call('POST', '/auth/login', {
        body: { identifier: OWNER.email, password: 'x' },
      });
      expect(response.status).toBe(401);
      expect(errorOf(response.body).code).toBe('identity.invalid_credentials');
    });
  });

  describe('the provisioning and sign-in journey', () => {
    let studentId: string;
    let studentLogin: Record<string, unknown>;

    it('lets the owner create, role and activate an account', async () => {
      const created = await api.call('POST', '/admin/users', {
        token: ownerToken,
        body: {
          displayName: 'Student One',
          identifier: STUDENT.email,
          initialPassword: STUDENT.password,
        },
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        status: 'PENDING',
        identifiers: [{ type: 'email', value: STUDENT.email }],
      });
      studentId = created.body.id as string;

      expect(
        (
          await api.call('POST', `/admin/users/${studentId}/roles`, {
            token: ownerToken,
            body: { role: 'STUDENT' },
          })
        ).status,
      ).toBe(200);
      const activated = await api.call('POST', `/admin/users/${studentId}/status`, {
        token: ownerToken,
        body: { status: 'ACTIVE' },
      });
      expect(activated.body.status).toBe('ACTIVE');
    });

    it('signs the new account in', async () => {
      const login = await api.call('POST', '/auth/login', {
        body: {
          identifier: STUDENT.email.toUpperCase(),
          password: STUDENT.password,
          device: { platform: 'android', label: 'Phone' },
        },
      });
      expect(login.status).toBe(200);
      expect(login.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
      expect(Object.keys(login.body).sort()).toEqual(
        [
          'accessToken',
          'expiresIn',
          'refreshToken',
          'refreshTokenExpiresAt',
          'sessionId',
          'tokenType',
          'user',
        ].sort(),
      );
      studentLogin = login.body;
    });

    it('returns a safe current-user representation from /auth/me', async () => {
      const me = await api.call('GET', '/auth/me', { token: studentLogin.accessToken as string });
      expect(me.status).toBe(200);
      expect(Object.keys(me.body).sort()).toEqual([
        'displayName',
        'id',
        'permissions',
        'roles',
        'status',
      ]);
      expect(me.body).toMatchObject({ id: studentId, status: 'ACTIVE', roles: ['STUDENT'] });
      expect(me.body.permissions).toEqual(expect.arrayContaining(['live.join', 'live.raise_hand']));
    });

    it('403 — refuses the student on an admin route', async () => {
      const response = await api.call('POST', '/admin/users', {
        token: studentLogin.accessToken as string,
        body: { displayName: 'X', identifier: 'x@x.test', initialPassword: 'whatever passphrase' },
      });
      expect(response.status).toBe(403);
      expect(errorOf(response.body).code).toBe('identity.permission_denied');
    });

    it('lists the student’s devices without exposing any token', async () => {
      const response = await api.call('GET', '/auth/sessions', {
        token: studentLogin.accessToken as string,
      });
      expect(response.status).toBe(200);
      const items = response.body.items as { current: boolean; device: { platform: string } }[];
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        current: true,
        device: { platform: 'android', label: 'Phone' },
      });
      expect(response.raw).not.toMatch(/token|hash/i);
    });

    it('rotates on refresh, and treats a replay as theft', async () => {
      const first = studentLogin.refreshToken as string;
      const rotated = await api.call('POST', '/auth/refresh', { body: { refreshToken: first } });
      expect(rotated.status).toBe(200);
      expect(rotated.body.refreshToken).not.toBe(first);

      const replay = await api.call('POST', '/auth/refresh', { body: { refreshToken: first } });
      expect(replay.status).toBe(401);
      expect(errorOf(replay.body).code).toBe('identity.refresh_token_invalid');

      // The whole session is gone — including the token that was just issued.
      const me = await api.call('GET', '/auth/me', { token: rotated.body.accessToken as string });
      expect(me.status).toBe(401);
    });

    it('ends access immediately on logout', async () => {
      const login = await api.call('POST', '/auth/login', {
        body: { identifier: STUDENT.email, password: STUDENT.password },
      });
      const token = login.body.accessToken as string;
      expect((await api.call('POST', '/auth/logout', { token })).status).toBe(204);
      expect((await api.call('GET', '/auth/me', { token })).status).toBe(401);
      expect(
        (
          await api.call('POST', '/auth/refresh', {
            body: { refreshToken: login.body.refreshToken },
          })
        ).status,
      ).toBe(401);
    });

    it('ends access immediately when an admin suspends the account', async () => {
      const login = await api.call('POST', '/auth/login', {
        body: { identifier: STUDENT.email, password: STUDENT.password },
      });
      const token = login.body.accessToken as string;
      expect((await api.call('GET', '/auth/me', { token })).status).toBe(200);

      await api.call('POST', `/admin/users/${studentId}/status`, {
        token: ownerToken,
        body: { status: 'SUSPENDED' },
      });

      expect((await api.call('GET', '/auth/me', { token })).status).toBe(401);
      const again = await api.call('POST', '/auth/login', {
        body: { identifier: STUDENT.email, password: STUDENT.password },
      });
      expect(again.status).toBe(403);
      expect(errorOf(again.body).code).toBe('identity.account_suspended');
    });

    it('refuses administrative action on your own account', async () => {
      const me = await api.call('GET', '/auth/me', { token: ownerToken });
      const response = await api.call('POST', `/admin/users/${me.body.id as string}/status`, {
        token: ownerToken,
        body: { status: 'DISABLED' },
      });
      expect(response.status).toBe(403);
      expect(errorOf(response.body).code).toBe('identity.self_administration');
    });
  });

  describe('what never leaves the API', () => {
    it('never returns a password hash, in any response so far', () => {
      const everything = api.transcript.join('\n');
      expect(everything).not.toContain('$scrypt$');
      expect(everything).not.toMatch(/passwordHash|password_hash/);
    });

    it('never echoes a password back, even in a validation error', async () => {
      const response = await api.call('POST', '/admin/users', {
        token: ownerToken,
        body: { displayName: 'Y', identifier: 'y@y.test', initialPassword: 'shortpw' },
      });
      expect(response.status).toBe(422);
      expect(response.raw).not.toContain('shortpw');
    });

    it('returns one error shape everywhere', async () => {
      for (const response of [
        await api.call('GET', '/auth/me'),
        await api.call('GET', '/no/such/route'),
        await api.call('POST', '/auth/login', { body: {} }),
        await api.call('POST', '/auth/refresh', { body: { refreshToken: 'x.y' } }),
      ]) {
        expect(Object.keys(response.body).sort()).toEqual(['error', 'requestId']);
        expect(typeof errorOf(response.body).code).toBe('string');
        expect(typeof errorOf(response.body).message).toBe('string');
      }
    });
  });
});

describe('identity API — rate limiting', () => {
  let api: RunningApi;

  beforeAll(async () => {
    api = await startApi();
  }, 60_000);

  afterAll(async () => {
    await api.close();
  });

  it('throttles repeated sign-in attempts with 429 and a Retry-After header', async () => {
    const statuses: number[] = [];
    let last: Awaited<ReturnType<RunningApi['call']>> | undefined;
    for (let attempt = 0; attempt < 11; attempt++) {
      last = await api.call('POST', '/auth/login', {
        body: { identifier: 'victim@institution.test', password: 'guess' },
      });
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(errorOf(last?.body ?? {}).code).toBe('identity.too_many_attempts');
  });

  it('throttles one address across many accounts', async () => {
    let status = 0;
    let retryAfter: string | null = null;
    for (let attempt = 0; attempt < 40 && status !== 429; attempt++) {
      const response = await api.call('POST', '/auth/login', {
        body: { identifier: `spray-${attempt}@institution.test`, password: 'guess' },
      });
      status = response.status;
      retryAfter = response.headers.get('retry-after');
      if (status === 429) expect(errorOf(response.body).code).toBe('platform.rate_limited');
    }
    expect(status).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});

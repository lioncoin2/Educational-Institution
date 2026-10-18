import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { startApi, type RunningApi } from '../support/api-client';

const OWNER = { email: 'owner@institution.test', password: 'owner passphrase one' };
const errorOf = (body: Record<string, unknown>) => body.error as { code: string };

/**
 * An access token expires on its own clock (JWT_ACCESS_TTL), and the session —
 * not the token — decides whether a renewal is allowed: an expired access
 * token is refused, the refresh token renews it once (rotating), and the
 * rotated-away refresh token is then theft that ends the session. Its own file:
 * configuration is read once per process, and this one runs three-second tokens.
 */
describe('session expiry API', () => {
  let api: RunningApi;

  beforeAll(async () => {
    // A token's `exp` is whole seconds from a whole-second `iat`, so an N-second
    // token lives between N-1 and N seconds: 3 s keeps the first checks clear of it.
    api = await startApi({ JWT_ACCESS_TTL: '3', REFRESH_SESSION_TTL_SECONDS: '3600' });
    const bootstrapped = await api.app.get(BootstrapOwnerUseCase).execute({
      displayName: 'Owner',
      identifierKind: 'email',
      identifier: OWNER.email,
      password: OWNER.password,
      meta: {},
    });
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.code);
  }, 60_000);

  afterAll(async () => {
    await api.close();
    delete process.env.JWT_ACCESS_TTL;
    delete process.env.REFRESH_SESSION_TTL_SECONDS;
  });

  it('refuses an expired access token, renews once by refresh, and treats the old refresh token as theft', async () => {
    const login = await api.call('POST', '/auth/login', {
      body: {
        identifier: OWNER.email,
        password: OWNER.password,
        device: { platform: 'web', label: 'Browser' },
      },
    });
    expect(login.body.expiresIn).toBe(3);
    const first = {
      access: login.body.accessToken as string,
      refresh: login.body.refreshToken as string,
    };
    expect((await api.call('GET', '/auth/me', { token: first.access })).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 4_200));
    const expired = await api.call('GET', '/auth/me', { token: first.access });
    expect(expired.status).toBe(401);
    expect(errorOf(expired.body).code).toBe('identity.authentication_required');

    const renewed = await api.call('POST', '/auth/refresh', {
      body: { refreshToken: first.refresh },
    });
    expect(renewed.status).toBe(200);
    const second = {
      access: renewed.body.accessToken as string,
      refresh: renewed.body.refreshToken as string,
    };
    expect(second.refresh).not.toBe(first.refresh);
    expect((await api.call('GET', '/auth/me', { token: second.access })).status).toBe(200);

    // A reload that replays the refresh token it held before the rotation —
    // or a thief who copied it — ends the session for everyone holding it.
    const replay = await api.call('POST', '/auth/refresh', {
      body: { refreshToken: first.refresh },
    });
    expect(replay.status).toBe(401);
    expect(errorOf(replay.body).code).toBe('identity.refresh_token_invalid');
    expect((await api.call('GET', '/auth/me', { token: second.access })).status).toBe(401);
    expect(
      (await api.call('POST', '/auth/refresh', { body: { refreshToken: second.refresh } })).status,
    ).toBe(401);
  }, 20_000);
});

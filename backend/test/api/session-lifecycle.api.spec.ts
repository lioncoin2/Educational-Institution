import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { startApi, type RunningApi } from '../support/api-client';

const OWNER = { email: 'owner@institution.test', password: 'owner passphrase one' };
const errorOf = (body: Record<string, unknown>) => body.error as { code: string; message: string };

interface Device {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly sessionId: string;
}

/**
 * Self-service session lifecycle over HTTP (session-management.md): changing
 * one's own password and ending one's own sessions, through the real routes,
 * guard, validation, throttling and error envelope. The use-case specs prove
 * the rules; this proves the wire — and that an ended session stops working
 * on the very next request, access token and refresh token alike.
 */
describe('session lifecycle API', () => {
  let api: RunningApi;
  let ownerToken: string;
  let accounts = 0;

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
    // One sign-in for the whole file: logins are throttled per address.
    ownerToken = (await signIn(OWNER.email, OWNER.password, 'Admin desk')).accessToken;
  }, 60_000);

  afterAll(async () => {
    await api.close();
  });

  async function signIn(email: string, password: string, label: string): Promise<Device> {
    const response = await api.call('POST', '/auth/login', {
      body: { identifier: email, password, device: { platform: 'web', label } },
    });
    expect(response.status).toBe(200);
    return {
      accessToken: response.body.accessToken as string,
      refreshToken: response.body.refreshToken as string,
      sessionId: response.body.sessionId as string,
    };
  }

  /** A fresh ACTIVE student, signed in on two devices. */
  async function studentOnTwoDevices(): Promise<{
    email: string;
    password: string;
    phone: Device;
    laptop: Device;
  }> {
    accounts += 1;
    const email = `student${accounts}@institution.test`;
    const password = `student passphrase ${accounts}`;
    const created = await api.call('POST', '/admin/users', {
      token: ownerToken,
      body: { displayName: `Student ${accounts}`, identifier: email, initialPassword: password },
    });
    const id = created.body.id as string;
    await api.call('POST', `/admin/users/${id}/roles`, {
      token: ownerToken,
      body: { role: 'STUDENT' },
    });
    await api.call('POST', `/admin/users/${id}/status`, {
      token: ownerToken,
      body: { status: 'ACTIVE' },
    });
    return {
      email,
      password,
      phone: await signIn(email, password, 'Phone'),
      laptop: await signIn(email, password, 'Laptop'),
    };
  }

  const me = (device: Device) => api.call('GET', '/auth/me', { token: device.accessToken });
  const refresh = (device: Device) =>
    api.call('POST', '/auth/refresh', { body: { refreshToken: device.refreshToken } });

  describe('POST /auth/password', () => {
    it('refuses without a session', async () => {
      const response = await api.call('POST', '/auth/password', {
        body: { currentPassword: 'x', newPassword: 'y' },
      });
      expect(response.status).toBe(401);
      expect(errorOf(response.body).code).toBe('identity.authentication_required');
    });

    it('refuses a wrong current password, a weak new one, an unchanged one — echoing none of them', async () => {
      const { phone, password } = await studentOnTwoDevices();
      const attempts: [Record<string, unknown>, number, string][] = [
        [
          { currentPassword: 'not my password at all', newPassword: 'a brand new passphrase' },
          422,
          'identity.current_password_incorrect',
        ],
        [{ currentPassword: password, newPassword: 'short' }, 422, 'identity.password_too_short'],
        [{ currentPassword: password, newPassword: password }, 422, 'identity.password_unchanged'],
        [{ currentPassword: password }, 400, 'bad_request'],
        [
          { currentPassword: password, newPassword: 'a brand new passphrase', extra: true },
          400,
          'bad_request',
        ],
      ];
      for (const [body, status, code] of attempts) {
        const response = await api.call('POST', '/auth/password', {
          token: phone.accessToken,
          body,
        });
        expect(response.status).toBe(status);
        expect(errorOf(response.body).code).toBe(code);
        expect(response.raw).not.toContain(password);
        expect(response.raw).not.toContain('brand new passphrase');
      }
      // None of the refusals changed anything: both devices still work.
      expect((await me(phone)).status).toBe(200);
    });

    it('changes it, ends every OTHER session at once, and keeps this one', async () => {
      const { email, password, phone, laptop } = await studentOnTwoDevices();
      const next = 'a brand new passphrase';

      const changed = await api.call('POST', '/auth/password', {
        token: phone.accessToken,
        body: { currentPassword: password, newPassword: next },
      });
      expect(changed.status).toBe(204);
      expect(changed.raw).toBe('');

      // The laptop is out — its unexpired access token and its refresh token.
      expect((await me(laptop)).status).toBe(401);
      const laptopRefresh = await refresh(laptop);
      expect(laptopRefresh.status).toBe(401);
      expect(errorOf(laptopRefresh.body).code).toBe('identity.refresh_token_invalid');
      // The phone that changed it stays signed in.
      expect((await me(phone)).status).toBe(200);
      // The old password no longer signs in; the new one does.
      const old = await api.call('POST', '/auth/login', {
        body: { identifier: email, password, device: { platform: 'web', label: 'x' } },
      });
      expect(old.status).toBe(401);
      expect((await signIn(email, next, 'Tablet')).accessToken).toEqual(expect.any(String));
    });

    it('throttles guesses at the current password per account, with Retry-After', async () => {
      const { phone } = await studentOnTwoDevices();
      const guess = () =>
        api.call('POST', '/auth/password', {
          token: phone.accessToken,
          body: { currentPassword: 'a wrong guess here', newPassword: 'a brand new passphrase' },
        });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await guess()).status).toBe(422);
      }
      const throttled = await guess();
      expect(throttled.status).toBe(429);
      expect(errorOf(throttled.body).code).toBe('identity.too_many_attempts');
      expect(Number(throttled.headers.get('retry-after'))).toBeGreaterThan(0);
    });
  });

  describe('GET /auth/sessions and DELETE /auth/sessions/:id', () => {
    it('lists the account’s own sessions, marking the one asking', async () => {
      const { phone, laptop } = await studentOnTwoDevices();
      const response = await api.call('GET', '/auth/sessions', { token: phone.accessToken });
      expect(response.status).toBe(200);
      const items = response.body.items as { id: string; current: boolean }[];
      expect(items.map((item) => item.id).sort()).toEqual(
        [phone.sessionId, laptop.sessionId].sort(),
      );
      expect(items.find((item) => item.id === phone.sessionId)?.current).toBe(true);
      expect(items.find((item) => item.id === laptop.sessionId)?.current).toBe(false);
      expect(response.raw).not.toContain(phone.refreshToken);
      expect(response.raw).not.toContain(laptop.accessToken);
    });

    it('ends another of one’s sessions: on its very next request it is out, refresh included', async () => {
      const { phone, laptop } = await studentOnTwoDevices();
      const ended = await api.call('DELETE', `/auth/sessions/${laptop.sessionId}`, {
        token: phone.accessToken,
      });
      expect(ended.status).toBe(204);

      expect((await me(laptop)).status).toBe(401);
      expect((await refresh(laptop)).status).toBe(401);
      expect((await me(phone)).status).toBe(200);
      // Ending it again: it is no longer anyone's to end.
      const again = await api.call('DELETE', `/auth/sessions/${laptop.sessionId}`, {
        token: phone.accessToken,
      });
      expect(again.status).toBe(404);
      expect(errorOf(again.body).code).toBe('identity.session_not_found');
    });

    it('reports someone else’s session exactly like one that does not exist — and leaves it running', async () => {
      const a = await studentOnTwoDevices();
      const b = await studentOnTwoDevices();
      const foreign = await api.call('DELETE', `/auth/sessions/${b.laptop.sessionId}`, {
        token: a.phone.accessToken,
      });
      const missing = await api.call(
        'DELETE',
        '/auth/sessions/00000000-0000-4000-8000-000000000000',
        { token: a.phone.accessToken },
      );
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(errorOf(foreign.body)).toEqual(errorOf(missing.body));
      expect((await me(b.laptop)).status).toBe(200);
    });

    it('ending the session asking is a sign-out of this device', async () => {
      const { phone, laptop } = await studentOnTwoDevices();
      const ended = await api.call('DELETE', `/auth/sessions/${phone.sessionId}`, {
        token: phone.accessToken,
      });
      expect(ended.status).toBe(204);
      expect((await me(phone)).status).toBe(401);
      expect((await me(laptop)).status).toBe(200);
    });

    it('refuses without a session', async () => {
      expect((await api.call('GET', '/auth/sessions')).status).toBe(401);
      expect((await api.call('DELETE', '/auth/sessions/anything')).status).toBe(401);
    });
  });
});

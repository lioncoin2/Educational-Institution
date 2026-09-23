import {
  DEFAULT_PASSWORD,
  META,
  expectErr,
  expectOk,
  identityHarness,
} from '../../../../test/support/identity-harness';
import { Roles } from '../domain/role';

const login = (
  h: ReturnType<typeof identityHarness>,
  identifier: string,
  password = DEFAULT_PASSWORD,
) =>
  h.login.execute({
    identifierKind: 'email',
    identifier,
    password,
    device: { platform: 'android' },
    meta: META,
  });

describe('LoginUseCase', () => {
  it('opens a session and returns both tokens and a safe user view', async () => {
    const h = identityHarness();
    const user = await h.seedUser({ email: 'teacher@example.com', roles: [Roles.teacher] });

    const signedIn = expectOk(await login(h, 'Teacher@Example.com'));

    expect(signedIn.user.id).toBe(user.id);
    expect(signedIn.user.roles).toEqual(['TEACHER']);
    expect(signedIn.user.permissions).toContain('live.moderate');
    expect(signedIn.refreshToken.startsWith(`${signedIn.sessionId}.`)).toBe(true);
    const [session] = h.sessions.all();
    expect(session?.device.platform).toBe('android');
    expect(h.audit.actions()).toEqual(['identity.login.succeeded']);
  });

  // Nothing that could be used to log in, or to crack one, leaves the use case.
  it('never returns a password hash or anything derived from it', async () => {
    const h = identityHarness();
    const user = await h.seedUser({ email: 'a@example.com' });
    const signedIn = expectOk(await login(h, 'a@example.com'));
    const serialized = JSON.stringify(signedIn);
    expect(serialized).not.toContain(user.passwordHash);
    expect(serialized).not.toContain('$scrypt$');
    expect(serialized).not.toMatch(/password/i);
  });

  it('stores only a hash of the refresh token, never the token', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'a@example.com' });
    const signedIn = expectOk(await login(h, 'a@example.com'));
    const [session] = h.sessions.all();
    const secret = signedIn.refreshToken.split('.')[1] ?? '';
    expect(JSON.stringify(session)).not.toContain(secret);
    expect(session?.refreshTokenHash).toBe(h.secrets.hash(secret));
  });

  describe('failures that must be indistinguishable', () => {
    it('answers an unknown account and a wrong password identically', async () => {
      const h = identityHarness();
      await h.seedUser({ email: 'a@example.com' });
      const unknown = expectErr(await login(h, 'nobody@example.com'));
      const wrong = expectErr(await login(h, 'a@example.com', 'not the password'));
      expect(unknown).toEqual(wrong);
      expect(unknown.code).toBe('identity.invalid_credentials');
      expect(unknown.kind).toBe('unauthenticated');
    });

    // The timing half of "indistinguishable": an unknown account must cost a
    // full password verification, exactly like a known one.
    it('runs a full password verification even when the account does not exist', async () => {
      const h = identityHarness();
      const verify = jest.spyOn(h.hasher, 'verify');
      await login(h, 'nobody@example.com');
      expect(verify).toHaveBeenCalledTimes(1);
      const [, hashUsed] = verify.mock.calls[0] ?? [];
      expect(hashUsed).toMatch(/^\$scrypt\$16384\$8\$1\$/); // a real hash, real parameters
    });

    it('records the failure without the attempted identifier or password', async () => {
      const h = identityHarness();
      await login(h, 'nobody@example.com', 'hunter2-typed-in-the-wrong-box');
      const entry = h.audit.last('identity.login.failed');
      expect(entry?.resourceId).toBe('unknown');
      expect(entry?.metadata).toEqual({ reason: 'invalid_credentials', ip: '203.0.113.7' });
      expect(JSON.stringify(h.audit.entries)).not.toContain('nobody@example.com');
      expect(JSON.stringify(h.audit.entries)).not.toContain('hunter2');
    });

    it('opens no session on failure', async () => {
      const h = identityHarness();
      await h.seedUser({ email: 'a@example.com' });
      await login(h, 'a@example.com', 'wrong password');
      expect(h.sessions.all()).toHaveLength(0);
    });
  });

  describe('account state', () => {
    it.each([
      ['SUSPENDED', 'identity.account_suspended'],
      ['DISABLED', 'identity.account_disabled'],
      ['PENDING', 'identity.account_pending'],
    ] as const)('rejects a %s account with a safe error', async (status, code) => {
      const h = identityHarness();
      await h.seedUser({ email: 'a@example.com', status });
      const error = expectErr(await login(h, 'a@example.com'));
      expect(error).toMatchObject({ kind: 'forbidden', code });
      expect(h.sessions.all()).toHaveLength(0);
    });

    // Account state is only revealed to someone who knew the password.
    it('does not reveal account state to someone with the wrong password', async () => {
      const h = identityHarness();
      await h.seedUser({ email: 'a@example.com', status: 'SUSPENDED' });
      expect(expectErr(await login(h, 'a@example.com', 'wrong password')).code).toBe(
        'identity.invalid_credentials',
      );
    });
  });

  describe('throttling (per account, in the use case)', () => {
    it('refuses further attempts once the account budget is spent, even with the right password', async () => {
      const h = identityHarness();
      await h.seedUser({ email: 'a@example.com' });
      for (let attempt = 0; attempt < 10; attempt++)
        await login(h, 'a@example.com', 'wrong password');

      const blocked = await login(h, 'a@example.com');
      expect(expectErr(blocked).code).toBe('identity.too_many_attempts');
      expect(!blocked.ok && blocked.error.kind).toBe('rate_limited');
    });

    it('lets the account in again once the window passes', async () => {
      const h = identityHarness();
      await h.seedUser({ email: 'a@example.com' });
      for (let attempt = 0; attempt < 11; attempt++)
        await login(h, 'a@example.com', 'wrong password');
      h.clock.advance(15 * 60);
      expect((await login(h, 'a@example.com')).ok).toBe(true);
    });

    it('clears the counter on success, so an owner who mistypes is not slowly locked out', async () => {
      const h = identityHarness();
      await h.seedUser({ email: 'a@example.com' });
      for (let round = 0; round < 3; round++) {
        for (let attempt = 0; attempt < 5; attempt++)
          await login(h, 'a@example.com', 'typo password');
        expect((await login(h, 'a@example.com')).ok).toBe(true);
      }
    });
  });

  it('upgrades a hash made with weaker parameters, without counting it as a password change', async () => {
    const h = identityHarness();
    const user = await h.seedUser({ email: 'a@example.com' });
    jest.spyOn(h.hasher, 'needsRehash').mockReturnValueOnce(true);

    expectOk(await login(h, 'a@example.com'));

    const stored = await h.userById(user.id);
    expect(stored.passwordHash).not.toBe(user.passwordHash);
    expect(stored.passwordChangedAt).toEqual(user.passwordChangedAt);
    expect(await h.hasher.verify(DEFAULT_PASSWORD, stored.passwordHash)).toBe(true);
  });
});

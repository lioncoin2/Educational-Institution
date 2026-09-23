import {
  META,
  expectErr,
  expectOk,
  identityHarness,
} from '../../../../test/support/identity-harness';

const refresh = (h: ReturnType<typeof identityHarness>, refreshToken: string) =>
  h.refresh.execute({ refreshToken, meta: META });

describe('RefreshSessionUseCase — rotation', () => {
  it('issues a new pair and retires the presented refresh token', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'a@example.com' });
    const first = await h.signIn('a@example.com');

    const second = expectOk(await refresh(h, first.refreshToken));

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.sessionId).toBe(first.sessionId);
    expect(await h.resolvePrincipal.execute(second.accessToken)).not.toBeNull();
    expect(h.audit.actions()).toContain('identity.session.refreshed');
  });

  it('keeps rotating: each new token works exactly once', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'a@example.com' });
    let token = (await h.signIn('a@example.com')).refreshToken;
    for (let i = 0; i < 5; i++) token = expectOk(await refresh(h, token)).refreshToken;
    expect(h.sessions.all()[0]?.generation).toBe(5);
  });

  it('never extends the session beyond its absolute expiry', async () => {
    const h = identityHarness({ refreshSessionTtlSeconds: 3600 });
    await h.seedUser({ email: 'a@example.com' });
    const first = await h.signIn('a@example.com');
    h.clock.advance(3000);
    const second = expectOk(await refresh(h, first.refreshToken));
    expect(second.refreshTokenExpiresAt).toEqual(first.refreshTokenExpiresAt);

    h.clock.advance(601);
    expect(expectErr(await refresh(h, second.refreshToken)).code).toBe(
      'identity.refresh_token_invalid',
    );
  });
});

describe('RefreshSessionUseCase — replay and reuse', () => {
  // The whole point of rotation: a token used twice means two parties held it.
  it('ends the session when a rotated token is replayed', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'a@example.com' });
    const stolen = (await h.signIn('a@example.com')).refreshToken;
    const legit = expectOk(await refresh(h, stolen)); // the owner refreshes first

    const replay = await refresh(h, stolen); // the thief tries the old token

    expect(expectErr(replay).code).toBe('identity.refresh_token_invalid');
    expect(h.sessions.all()[0]?.revokedReason).toBe('refresh_token_reuse');
    expect(h.audit.actions()).toContain('identity.session.refresh_reuse_detected');
    // …which cuts off the owner's branch too: both must sign in again.
    expect(expectErr(await refresh(h, legit.refreshToken)).code).toBe(
      'identity.refresh_token_invalid',
    );
    expect(await h.resolvePrincipal.execute(legit.accessToken)).toBeNull();
  });

  it('ends the session when the thief rotates first and the owner replays', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'a@example.com' });
    const shared = (await h.signIn('a@example.com')).refreshToken;
    const thief = expectOk(await refresh(h, shared));

    expectErr(await refresh(h, shared)); // the owner, holding the retired token

    expect(expectErr(await refresh(h, thief.refreshToken)).code).toBe(
      'identity.refresh_token_invalid',
    );
  });

  it('lets only one of two concurrent refreshes with the same token succeed, and ends the session', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'a@example.com' });
    const token = (await h.signIn('a@example.com')).refreshToken;

    const results = await Promise.all([refresh(h, token), refresh(h, token)]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(h.sessions.all()[0]?.revokedReason).toBe('refresh_token_reuse');
  });

  // A logout landing between our read and our swap is not theft, and the
  // audit trail must not call it that.
  it('does not report reuse when the session was ended mid-refresh', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'a@example.com' });
    const signedIn = await h.signIn('a@example.com');
    const rotate = h.sessions.rotate.bind(h.sessions);
    jest.spyOn(h.sessions, 'rotate').mockImplementationOnce(async (next, expected) => {
      await h.sessions.revoke(next.id, 'logout', h.clock.now());
      return rotate(next, expected);
    });

    expect(expectErr(await refresh(h, signedIn.refreshToken)).code).toBe(
      'identity.refresh_token_invalid',
    );
    expect(h.audit.actions()).not.toContain('identity.session.refresh_reuse_detected');
    expect(h.sessions.all()[0]?.revokedReason).toBe('logout');
  });

  // Knowing a session id proves nothing. It must not be enough to sign the
  // session's owner out — or anyone who saw an id could do it at will.
  it('does not end the session for a forged secret on a real session id', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'a@example.com' });
    const real = await h.signIn('a@example.com');

    const forged = `${real.sessionId}.${'A'.repeat(43)}`;
    expect(expectErr(await refresh(h, forged)).code).toBe('identity.refresh_token_invalid');

    expect(h.sessions.all()[0]?.revokedAt).toBeNull();
    expect((await refresh(h, real.refreshToken)).ok).toBe(true);
    expect(h.audit.last('identity.session.refresh_rejected')?.metadata).toMatchObject({
      reason: 'token_mismatch',
    });
  });

  it.each(['', 'garbage', 'a.b', `${'x'.repeat(300)}`])(
    'rejects malformed token %j',
    async (token) => {
      const h = identityHarness();
      expect(expectErr(await refresh(h, token)).code).toBe('identity.refresh_token_invalid');
    },
  );

  it('refuses to refresh a session after logout', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'a@example.com' });
    const signedIn = await h.signIn('a@example.com');
    const principal = await h.resolvePrincipal.execute(signedIn.accessToken);
    expectOk(await h.logout.execute({ principal: principal!, meta: META }));

    expect(expectErr(await refresh(h, signedIn.refreshToken)).code).toBe(
      'identity.refresh_token_invalid',
    );
  });

  it('ends the session if the account was suspended meanwhile', async () => {
    const h = identityHarness();
    const user = await h.seedUser({ email: 'a@example.com' });
    const signedIn = await h.signIn('a@example.com');
    await h.users.save({ ...(await h.userById(user.id)), status: 'SUSPENDED' });

    expect(expectErr(await refresh(h, signedIn.refreshToken)).code).toBe(
      'identity.account_suspended',
    );
    expect(h.sessions.all()[0]?.revokedReason).toBe('account_inactive');
  });
});

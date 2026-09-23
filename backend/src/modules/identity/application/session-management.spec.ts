import {
  META,
  expectErr,
  expectOk,
  identityHarness,
} from '../../../../test/support/identity-harness';

describe('session management', () => {
  async function twoDevices() {
    const h = identityHarness();
    await h.seedUser({ email: 'a@example.com' });
    const phone = await h.signIn('a@example.com');
    h.clock.advance(60);
    const tablet = await h.signIn('a@example.com');
    const principal = (await h.resolvePrincipal.execute(phone.accessToken))!;
    return { h, phone, tablet, principal };
  }

  describe('logout', () => {
    it('ends the current session only — immediately, not at token expiry', async () => {
      const { h, phone, tablet, principal } = await twoDevices();

      expectOk(await h.logout.execute({ principal, meta: META }));

      expect(await h.resolvePrincipal.execute(phone.accessToken)).toBeNull();
      expect(await h.resolvePrincipal.execute(tablet.accessToken)).not.toBeNull();
      expect(h.audit.last('identity.logout')?.resourceId).toBe(phone.sessionId);
    });

    it('refuses a principal that has no session (a system principal)', async () => {
      const h = identityHarness();
      const error = expectErr(
        await h.logout.execute({
          principal: { userId: 'system:job', roles: [], permissions: new Set() },
          meta: META,
        }),
      );
      expect(error.code).toBe('identity.no_session');
    });
  });

  describe('listing', () => {
    it('lists each signed-in device, most recently used first, marking the current one', async () => {
      const { h, phone, tablet, principal } = await twoDevices();

      const sessions = expectOk(await h.listSessions.execute({ principal }));

      expect(sessions.map((session) => session.id)).toEqual([tablet.sessionId, phone.sessionId]);
      expect(sessions.find((session) => session.current)?.id).toBe(phone.sessionId);
      expect(sessions[0]?.device).toEqual({
        platform: 'ios',
        label: 'Test device',
        appVersion: null,
      });
    });

    it('never exposes token hashes', async () => {
      const { h, principal } = await twoDevices();
      const serialized = JSON.stringify(expectOk(await h.listSessions.execute({ principal })));
      expect(serialized).not.toMatch(/hash|token/i);
    });

    it('omits revoked and expired sessions', async () => {
      const { h, tablet, principal } = await twoDevices();
      expectOk(
        await h.revokeSession.execute({ principal, sessionId: tablet.sessionId, meta: META }),
      );
      expect(expectOk(await h.listSessions.execute({ principal }))).toHaveLength(1);

      h.clock.advance(31 * 24 * 60 * 60);
      expect(expectOk(await h.listSessions.execute({ principal }))).toHaveLength(0);
    });
  });

  describe('revoking one of your own sessions', () => {
    it('signs the other device out', async () => {
      const { h, tablet, principal } = await twoDevices();

      expectOk(
        await h.revokeSession.execute({ principal, sessionId: tablet.sessionId, meta: META }),
      );

      expect(await h.resolvePrincipal.execute(tablet.accessToken)).toBeNull();
      expect(h.audit.last('identity.session.revoked')?.metadata).toEqual({
        reason: 'revoked_by_user',
      });
    });

    // Another person's session is reported exactly like one that does not
    // exist, so the endpoint cannot be used to discover session ids.
    it("reports someone else's session as not found, and leaves it alone", async () => {
      const { h, principal } = await twoDevices();
      await h.seedUser({ email: 'b@example.com' });
      const other = await h.signIn('b@example.com');

      const error = expectErr(
        await h.revokeSession.execute({ principal, sessionId: other.sessionId, meta: META }),
      );
      expect(error).toEqual(
        expectErr(
          await h.revokeSession.execute({ principal, sessionId: 'no-such-session', meta: META }),
        ),
      );
      expect(error.code).toBe('identity.session_not_found');
      expect(await h.resolvePrincipal.execute(other.accessToken)).not.toBeNull();
    });
  });
});

describe('ResolvePrincipalUseCase', () => {
  it('resolves roles from storage, so a revoked role stops working on the next request', async () => {
    const h = identityHarness();
    const owner = await h.seedUser({ email: 'owner@example.com', roles: ['OWNER'] });
    const teacher = await h.seedUser({ email: 't@example.com', roles: ['TEACHER'] });
    const signedIn = await h.signIn('t@example.com');
    expect(
      (await h.resolvePrincipal.execute(signedIn.accessToken))?.permissions.has('live.moderate'),
    ).toBe(true);

    const actor = (await h.resolvePrincipal.execute(
      (await h.signIn('owner@example.com')).accessToken,
    ))!;
    expectOk(
      await h.revokeRole.execute({ actor, userId: teacher.id, role: 'TEACHER', meta: META }),
    );

    // Same, unexpired access token — but the role is gone.
    const after = await h.resolvePrincipal.execute(signedIn.accessToken);
    expect(after?.roles).toEqual([]);
    expect(after?.permissions.has('live.moderate')).toBe(false);
    expect(owner.id).toBeDefined();
  });

  it('refuses a token whose account has since been suspended', async () => {
    const h = identityHarness();
    const user = await h.seedUser({ email: 'a@example.com' });
    const signedIn = await h.signIn('a@example.com');
    await h.users.save({ ...(await h.userById(user.id)), status: 'SUSPENDED' });
    expect(await h.resolvePrincipal.execute(signedIn.accessToken)).toBeNull();
  });

  // The session's end cuts off an access token that is itself still valid.
  it('refuses a still-valid access token once its session has expired', async () => {
    const h = identityHarness({ refreshSessionTtlSeconds: 1800 });
    await h.seedUser({ email: 'a@example.com' });
    const signedIn = await h.signIn('a@example.com');
    h.clock.advance(1500);
    const fresh = expectOk(
      await h.refresh.execute({ refreshToken: signedIn.refreshToken, meta: META }),
    );

    h.clock.advance(299); // access token 299s old (valid for 900); session at 1799 of 1800
    expect(await h.resolvePrincipal.execute(fresh.accessToken)).not.toBeNull();
    h.clock.advance(1); // session over; access token still well inside its own lifetime
    expect(await h.resolvePrincipal.execute(fresh.accessToken)).toBeNull();
  });

  it('refuses an expired access token even while the session lives', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'a@example.com' });
    const signedIn = await h.signIn('a@example.com');
    h.clock.advance(901);
    expect(await h.resolvePrincipal.execute(signedIn.accessToken)).toBeNull();
  });

  it('refuses garbage', async () => {
    const h = identityHarness();
    for (const token of ['', 'abc', 'a.b.c', 'Bearer x']) {
      expect(await h.resolvePrincipal.execute(token)).toBeNull();
      expect(await h.resolvePrincipal.authenticate(token)).toBeNull();
    }
  });
});

// The same decision, offered to transports that are not a request.
describe('ResolvePrincipalUseCase as the AccessTokenAuthenticator', () => {
  it('authenticates with the principal the guard would see, and the token expiry', async () => {
    const h = identityHarness();
    const user = await h.seedUser({ email: 'a@example.com', roles: ['STUDENT'] });
    const signedIn = await h.signIn('a@example.com');

    const authentication = await h.resolvePrincipal.authenticate(signedIn.accessToken);

    expect(authentication?.principal).toEqual(
      await h.resolvePrincipal.execute(signedIn.accessToken),
    );
    expect(authentication?.principal.userId).toBe(user.id);
    expect(authentication?.expiresAt).toEqual(new Date(h.clock.now().getTime() + 900_000));
  });

  it('refuses an expired token and a revoked session alike', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'a@example.com' });
    const expired = await h.signIn('a@example.com');
    h.clock.advance(901);
    expect(await h.resolvePrincipal.authenticate(expired.accessToken)).toBeNull();

    const live = await h.signIn('a@example.com');
    const principal = (await h.resolvePrincipal.execute(live.accessToken))!;
    expectOk(await h.logout.execute({ principal, meta: META }));
    expect(await h.resolvePrincipal.authenticate(live.accessToken)).toBeNull();
  });

  it('revalidates a principal without its token — and stops once the session ends', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'a@example.com', roles: ['TEACHER'] });
    const signedIn = await h.signIn('a@example.com');
    const principal = (await h.resolvePrincipal.execute(signedIn.accessToken))!;

    const session = { userId: principal.userId, sessionId: principal.sessionId! };
    expect(await h.resolvePrincipal.revalidate(session)).toEqual(principal);

    expectOk(await h.logout.execute({ principal, meta: META }));
    expect(await h.resolvePrincipal.revalidate(session)).toBeNull();
  });

  it('revalidates with permissions as they are now, and not at all once suspended', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'owner@example.com', roles: ['OWNER'] });
    const teacher = await h.seedUser({ email: 't@example.com', roles: ['TEACHER'] });
    const principal = await h.principalOf('t@example.com');
    const actor = await h.principalOf('owner@example.com');

    const session = { userId: principal.userId, sessionId: principal.sessionId! };
    expectOk(
      await h.revokeRole.execute({ actor, userId: teacher.id, role: 'TEACHER', meta: META }),
    );
    const demoted = await h.resolvePrincipal.revalidate(session);
    expect(demoted?.roles).toEqual([]);
    expect(demoted?.permissions.has('messaging.read')).toBe(false);

    await h.users.save({ ...(await h.userById(teacher.id)), status: 'SUSPENDED' });
    expect(await h.resolvePrincipal.revalidate(session)).toBeNull();
  });

  it("never revalidates a session under someone else's account", async () => {
    const h = identityHarness();
    const other = await h.seedUser({ email: 'b@example.com' });
    await h.seedUser({ email: 'a@example.com' });
    const principal = await h.principalOf('a@example.com');
    expect(
      await h.resolvePrincipal.revalidate({ userId: other.id, sessionId: principal.sessionId! }),
    ).toBeNull();
  });
});

describe('GetCurrentUserUseCase', () => {
  it('returns id, name, status, roles and permissions — and nothing secret', async () => {
    const h = identityHarness();
    const user = await h.seedUser({ email: 'a@example.com', roles: ['STUDENT'] });
    const principal = await h.principalOf('a@example.com');

    const me = expectOk(await h.currentUser.execute({ principal }));

    expect(Object.keys(me).sort()).toEqual(['displayName', 'id', 'permissions', 'roles', 'status']);
    expect(me).toMatchObject({ id: user.id, status: 'ACTIVE', roles: ['STUDENT'] });
    expect(me.permissions).toContain('live.raise_hand');
    expect(JSON.stringify(me)).not.toContain(user.passwordHash);
  });
});

describe('ChangeMyPasswordUseCase', () => {
  async function setup() {
    const h = identityHarness();
    const user = await h.seedUser({ email: 'a@example.com' });
    const here = await h.signIn('a@example.com');
    const elsewhere = await h.signIn('a@example.com');
    const principal = (await h.resolvePrincipal.execute(here.accessToken))!;
    return { h, user, here, elsewhere, principal };
  }

  it('changes the password and ends every OTHER session', async () => {
    const { h, here, elsewhere, principal } = await setup();

    expectOk(
      await h.changePassword.execute({
        principal,
        currentPassword: 'correct horse battery staple',
        newPassword: 'a brand new passphrase',
        meta: META,
      }),
    );

    expect(await h.resolvePrincipal.execute(here.accessToken)).not.toBeNull();
    expect(await h.resolvePrincipal.execute(elsewhere.accessToken)).toBeNull();
    expect(
      (
        await h.login.execute({
          identifierKind: 'email',
          identifier: 'a@example.com',
          password: 'a brand new passphrase',
          device: {},
          meta: META,
        })
      ).ok,
    ).toBe(true);
    expect(h.audit.last('identity.password.changed')?.metadata).toMatchObject({
      otherSessionsEnded: 1,
    });
  });

  it('requires the current password', async () => {
    const { h, principal } = await setup();
    const error = expectErr(
      await h.changePassword.execute({
        principal,
        currentPassword: 'wrong',
        newPassword: 'another passphrase',
        meta: META,
      }),
    );
    expect(error.code).toBe('identity.current_password_incorrect');
  });

  it('applies the new-password policy', async () => {
    const { h, principal } = await setup();
    const error = expectErr(
      await h.changePassword.execute({
        principal,
        currentPassword: 'correct horse battery staple',
        newPassword: 'short',
        meta: META,
      }),
    );
    expect(error.code).toBe('identity.password_too_short');
  });

  it('rejects reusing the current password', async () => {
    const { h, principal } = await setup();
    const error = expectErr(
      await h.changePassword.execute({
        principal,
        currentPassword: 'correct horse battery staple',
        newPassword: 'correct horse battery staple',
        meta: META,
      }),
    );
    expect(error.code).toBe('identity.password_unchanged');
  });

  // A stolen access token must not be an unthrottled oracle for the password.
  it('throttles attempts per user', async () => {
    const { h, principal } = await setup();
    for (let i = 0; i < 5; i++) {
      await h.changePassword.execute({
        principal,
        currentPassword: 'guess',
        newPassword: 'whatever passphrase',
        meta: META,
      });
    }
    const error = expectErr(
      await h.changePassword.execute({
        principal,
        currentPassword: 'correct horse battery staple',
        newPassword: 'fine passphrase',
        meta: META,
      }),
    );
    expect(error.kind).toBe('rate_limited');
  });

  it('never records either password in the audit trail', async () => {
    const { h, principal } = await setup();
    await h.changePassword.execute({
      principal,
      currentPassword: 'correct horse battery staple',
      newPassword: 'a brand new passphrase',
      meta: META,
    });
    const audit = JSON.stringify(h.audit.entries);
    expect(audit).not.toContain('correct horse');
    expect(audit).not.toContain('brand new');
  });
});

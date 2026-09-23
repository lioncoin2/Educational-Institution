import {
  META,
  expectErr,
  expectOk,
  identityHarness,
} from '../../../../test/support/identity-harness';

const bootstrap = (h: ReturnType<typeof identityHarness>, email = 'founder@example.com') =>
  h.bootstrapOwner.execute({
    displayName: 'Founder',
    identifierKind: 'email',
    identifier: email,
    password: 'founder passphrase',
    meta: META,
  });

describe('BootstrapOwnerUseCase', () => {
  it('creates an active OWNER in an empty system', async () => {
    const h = identityHarness();
    const owner = expectOk(await bootstrap(h));
    expect(owner.status).toBe('ACTIVE');
    expect(owner.roles.map((role) => role.code)).toEqual(['OWNER']);
    expect(owner.roles[0]?.grantedBy).toBeNull();
    expect(
      (await h.signIn('founder@example.com', 'founder passphrase')).user.permissions,
    ).toContain('settings.manage');
    expect(h.audit.last('identity.owner.bootstrapped')?.actorUserId).toBeNull();
  });

  it('refuses once an active owner exists', async () => {
    const h = identityHarness();
    expectOk(await bootstrap(h));
    expect(expectErr(await bootstrap(h, 'second@example.com')).code).toBe('identity.owner_exists');
  });

  // Recovery path: a system whose every owner is suspended can be re-seeded by
  // an operator with shell access — who could edit the database anyway.
  it('runs again if no owner is active', async () => {
    const h = identityHarness();
    await h.seedUser({ email: 'old-owner@example.com', roles: ['OWNER'], status: 'SUSPENDED' });
    expect((await bootstrap(h)).ok).toBe(true);
  });

  it('applies the password policy', async () => {
    const h = identityHarness();
    const result = await h.bootstrapOwner.execute({
      displayName: 'Founder',
      identifierKind: 'email',
      identifier: 'founder@example.com',
      password: 'short',
      meta: META,
    });
    expect(expectErr(result).code).toBe('identity.password_too_short');
  });
});

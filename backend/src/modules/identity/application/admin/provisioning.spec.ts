import {
  META,
  expectErr,
  expectOk,
  identityHarness,
} from '../../../../../test/support/identity-harness';
import { Permissions, systemPrincipal } from '../../contracts';

async function withAdmins() {
  const h = identityHarness();
  await h.seedUser({ email: 'owner@example.com', roles: ['OWNER'] });
  await h.seedUser({ email: 'owner2@example.com', roles: ['OWNER'] });
  await h.seedUser({ email: 'admin@example.com', roles: ['ADMIN'] });
  await h.seedUser({ email: 'student@example.com', roles: ['STUDENT'] });
  return {
    h,
    owner: await h.principalOf('owner@example.com'),
    admin: await h.principalOf('admin@example.com'),
    student: await h.principalOf('student@example.com'),
  };
}

const newAccount = {
  displayName: 'Yusuf',
  identifierKind: 'email',
  identifier: 'yusuf@example.com',
  initialPassword: 'initial passphrase',
  meta: META,
} as const;

describe('provisioning: create → assign role → activate', () => {
  it('walks an account from creation to its first sign-in', async () => {
    const { h, admin } = await withAdmins();

    const created = expectOk(await h.createUser.execute({ actor: admin, ...newAccount }));
    expect(created).toMatchObject({
      status: 'PENDING',
      roles: [],
      identifiers: [{ kind: 'email', value: 'yusuf@example.com' }],
    });

    // Not yet usable.
    const early = await h.login.execute({
      identifierKind: 'email',
      identifier: 'yusuf@example.com',
      password: 'initial passphrase',
      device: {},
      meta: META,
    });
    expect(expectErr(early).code).toBe('identity.account_pending');

    expectOk(
      await h.assignRole.execute({ actor: admin, userId: created.id, role: 'STUDENT', meta: META }),
    );
    const active = expectOk(
      await h.changeStatus.execute({
        actor: admin,
        userId: created.id,
        status: 'ACTIVE',
        meta: META,
      }),
    );
    expect(active.status).toBe('ACTIVE');

    const signedIn = await h.signIn('yusuf@example.com', 'initial passphrase');
    expect(signedIn.user.roles).toEqual(['STUDENT']);
    expect(h.audit.actions()).toEqual(
      expect.arrayContaining([
        'identity.user.created',
        'identity.role.assigned',
        'identity.account.activated',
      ]),
    );
    expect(h.events.published.map((event) => event.name)).toEqual([
      'identity.user.created',
      'identity.role.assigned',
      'identity.account.status_changed',
    ]);
  });

  it('keeps personal data out of event payloads', async () => {
    const { h, admin } = await withAdmins();
    expectOk(await h.createUser.execute({ actor: admin, ...newAccount }));
    const payloads = JSON.stringify(h.events.published);
    expect(payloads).not.toContain('yusuf@example.com');
    expect(payloads).not.toContain('Yusuf');
  });

  it('never returns a password hash from any provisioning call', async () => {
    const { h, admin } = await withAdmins();
    const created = expectOk(await h.createUser.execute({ actor: admin, ...newAccount }));
    expect(JSON.stringify(created)).not.toMatch(/scrypt|password/i);
  });

  it('refuses a second account with the same identifier, in any letter case', async () => {
    const { h, admin } = await withAdmins();
    expectOk(await h.createUser.execute({ actor: admin, ...newAccount }));
    const error = expectErr(
      await h.createUser.execute({ actor: admin, ...newAccount, identifier: 'YUSUF@example.com' }),
    );
    expect(error).toMatchObject({ kind: 'conflict', code: 'identity.identifier_taken' });
  });

  it('applies the password policy to the initial password', async () => {
    const { h, admin } = await withAdmins();
    const error = expectErr(
      await h.createUser.execute({ actor: admin, ...newAccount, initialPassword: 'short' }),
    );
    expect(error.code).toBe('identity.password_too_short');
  });

  it('refuses an unknown role', async () => {
    const { h, admin } = await withAdmins();
    const created = expectOk(await h.createUser.execute({ actor: admin, ...newAccount }));
    const error = expectErr(
      await h.assignRole.execute({ actor: admin, userId: created.id, role: 'PARENT', meta: META }),
    );
    expect(error.code).toBe('identity.role_unknown');
  });
});

describe('authorization at the application boundary', () => {
  it('refuses a caller without users.manage, before touching storage', async () => {
    const { h, student } = await withAdmins();
    const create = jest.spyOn(h.users, 'create');
    const error = expectErr(await h.createUser.execute({ actor: student, ...newAccount }));
    expect(error).toMatchObject({ kind: 'forbidden', code: 'identity.permission_denied' });
    expect(create).not.toHaveBeenCalled();
  });

  // No guard runs when a job calls a use case. The use case must hold the line itself.
  it('holds a system principal to exactly its granted permissions', async () => {
    const { h } = await withAdmins();
    const importer = systemPrincipal('student-import', [Permissions.users.manage]);

    const created = expectOk(await h.createUser.execute({ actor: importer, ...newAccount }));
    const error = expectErr(
      await h.assignRole.execute({
        actor: importer,
        userId: created.id,
        role: 'STUDENT',
        meta: META,
      }),
    );
    expect(error.code).toBe('identity.permission_denied');
  });

  it('does not reveal whether an account exists to a caller without permission', async () => {
    const { h, student } = await withAdmins();
    const real = (await h.users.list({ limit: 1 })).items[0];
    const onReal = expectErr(
      await h.changeStatus.execute({
        actor: student,
        userId: real.id,
        status: 'SUSPENDED',
        meta: META,
      }),
    );
    const onMissing = expectErr(
      await h.changeStatus.execute({
        actor: student,
        userId: 'nope',
        status: 'SUSPENDED',
        meta: META,
      }),
    );
    expect(onReal).toEqual(onMissing);
  });
});

describe('no escalation', () => {
  it('stops an admin granting a role with permissions the admin lacks (OWNER)', async () => {
    const { h, admin } = await withAdmins();
    const created = expectOk(await h.createUser.execute({ actor: admin, ...newAccount }));
    const error = expectErr(
      await h.assignRole.execute({ actor: admin, userId: created.id, role: 'OWNER', meta: META }),
    );
    expect(error).toMatchObject({ kind: 'forbidden', code: 'identity.role_outranks_actor' });
  });

  // Resetting someone's password is signing in as them.
  it("stops an admin resetting an owner's password", async () => {
    const { h, admin } = await withAdmins();
    const ownerAccount = (await h.users.findByIdentifier({
      kind: 'email',
      value: 'owner@example.com',
    }))!;
    const error = expectErr(
      await h.resetPassword.execute({
        actor: admin,
        userId: ownerAccount.id,
        newPassword: 'taken over now',
        meta: META,
      }),
    );
    expect(error.code).toBe('identity.target_outranks_actor');
  });

  it('stops an admin suspending an owner', async () => {
    const { h, admin } = await withAdmins();
    const ownerAccount = (await h.users.findByIdentifier({
      kind: 'email',
      value: 'owner@example.com',
    }))!;
    const error = expectErr(
      await h.changeStatus.execute({
        actor: admin,
        userId: ownerAccount.id,
        status: 'SUSPENDED',
        meta: META,
      }),
    );
    expect(error.code).toBe('identity.target_outranks_actor');
  });

  it('lets an owner administer another owner', async () => {
    const { h, owner } = await withAdmins();
    const other = (await h.users.findByIdentifier({ kind: 'email', value: 'owner2@example.com' }))!;
    expect(
      (
        await h.changeStatus.execute({
          actor: owner,
          userId: other.id,
          status: 'SUSPENDED',
          meta: META,
        })
      ).ok,
    ).toBe(true);
  });

  // Together with no-escalation, this means the last fully-privileged account
  // can never be locked out through the API.
  it('refuses administrative actions on your own account', async () => {
    const { h, owner } = await withAdmins();
    for (const result of [
      await h.changeStatus.execute({
        actor: owner,
        userId: owner.userId,
        status: 'DISABLED',
        meta: META,
      }),
      await h.revokeRole.execute({ actor: owner, userId: owner.userId, role: 'OWNER', meta: META }),
      await h.resetPassword.execute({
        actor: owner,
        userId: owner.userId,
        newPassword: 'whatever works',
        meta: META,
      }),
    ]) {
      expect(expectErr(result).code).toBe('identity.self_administration');
    }
  });
});

describe('account status changes', () => {
  it('ends every session when an account is suspended, effective on the next request', async () => {
    const { h, admin } = await withAdmins();
    const student = (await h.users.findByIdentifier({
      kind: 'email',
      value: 'student@example.com',
    }))!;
    const a = await h.signIn('student@example.com');
    const b = await h.signIn('student@example.com');

    const result = expectOk(
      await h.changeStatus.execute({
        actor: admin,
        userId: student.id,
        status: 'SUSPENDED',
        meta: META,
      }),
    );

    expect(result.status).toBe('SUSPENDED');
    for (const signedIn of [a, b]) {
      expect(await h.resolvePrincipal.execute(signedIn.accessToken)).toBeNull();
      expect(
        (await h.refresh.execute({ refreshToken: signedIn.refreshToken, meta: META })).ok,
      ).toBe(false);
    }
    expect(h.audit.last('identity.account.suspended')?.metadata).toMatchObject({
      from: 'ACTIVE',
      to: 'SUSPENDED',
    });
  });

  it('audits a disable as "account disabled"', async () => {
    const { h, admin } = await withAdmins();
    const student = (await h.users.findByIdentifier({
      kind: 'email',
      value: 'student@example.com',
    }))!;
    expectOk(
      await h.changeStatus.execute({
        actor: admin,
        userId: student.id,
        status: 'DISABLED',
        meta: META,
      }),
    );
    expect(h.audit.last('identity.account.disabled')?.resourceId).toBe(student.id);
  });

  it('rejects an incoherent transition', async () => {
    const { h, admin } = await withAdmins();
    const created = expectOk(await h.createUser.execute({ actor: admin, ...newAccount }));
    const error = expectErr(
      await h.changeStatus.execute({
        actor: admin,
        userId: created.id,
        status: 'SUSPENDED',
        meta: META,
      }),
    );
    expect(error.code).toBe('identity.status_transition_invalid');
  });
});

describe('password reset and session revocation by staff', () => {
  it('resets a password and signs the account out everywhere', async () => {
    const { h, admin } = await withAdmins();
    const student = (await h.users.findByIdentifier({
      kind: 'email',
      value: 'student@example.com',
    }))!;
    const before = await h.signIn('student@example.com');

    expectOk(
      await h.resetPassword.execute({
        actor: admin,
        userId: student.id,
        newPassword: 'reset passphrase',
        meta: META,
      }),
    );

    expect(await h.resolvePrincipal.execute(before.accessToken)).toBeNull();
    expect((await h.signIn('student@example.com', 'reset passphrase')).user.id).toBe(student.id);
    expect(JSON.stringify(h.audit.entries)).not.toContain('reset passphrase');
  });

  it('signs an account out everywhere without changing anything else', async () => {
    const { h, admin } = await withAdmins();
    const student = (await h.users.findByIdentifier({
      kind: 'email',
      value: 'student@example.com',
    }))!;
    await h.signIn('student@example.com');

    const result = expectOk(
      await h.revokeUserSessions.execute({ actor: admin, userId: student.id, meta: META }),
    );

    expect(result.sessionsEnded).toBeGreaterThanOrEqual(2); // withAdmins() signed in once already
    expect((await h.userById(student.id)).status).toBe('ACTIVE');
  });
});

describe('reading accounts', () => {
  it('pages through accounts with a cursor', async () => {
    const { h, admin } = await withAdmins();
    const first = expectOk(await h.listUsers.execute({ actor: admin, page: { limit: 3 } }));
    expect(first.items).toHaveLength(3);
    const second = expectOk(
      await h.listUsers.execute({ actor: admin, page: { limit: 3, cursor: first.nextCursor } }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
  });

  it('requires users.read', async () => {
    const { h, student } = await withAdmins();
    expect(expectErr(await h.listUsers.execute({ actor: student, page: { limit: 10 } })).code).toBe(
      'identity.permission_denied',
    );
  });
});

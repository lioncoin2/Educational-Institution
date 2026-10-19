import { asId, FixedClock } from '../../../shared';
import { createUser, type User } from '../domain/user';
import { InMemoryUserRepository } from '../infrastructure/in-memory-identity-store';
import { IdentityAccountAvatarWriter } from './account-avatar.service';

const AT = new Date('2026-09-01T08:00:00Z');
const LATER = new Date('2026-10-18T08:00:00Z');

function account(): User {
  const created = createUser({
    id: asId<'User'>('u-1'),
    displayName: 'Amina',
    identifier: { kind: 'email', value: 'amina@example.com' },
    passwordHash: 'hash',
    at: AT,
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

describe('IdentityAccountAvatarWriter', () => {
  it('records and clears an account picture, stamping updatedAt', async () => {
    const users = new InMemoryUserRepository([account()]);
    const writer = new IdentityAccountAvatarWriter(users, new FixedClock(LATER));

    const set = await writer.setAvatar('u-1', 'file-1');
    expect(set.ok).toBe(true);
    expect((await users.findById(asId<'User'>('u-1')))?.avatarFileAssetId).toBe('file-1');
    expect((await users.findById(asId<'User'>('u-1')))?.updatedAt).toEqual(LATER);

    const cleared = await writer.clearAvatar('u-1');
    expect(cleared.ok).toBe(true);
    expect((await users.findById(asId<'User'>('u-1')))?.avatarFileAssetId).toBeNull();
  });

  it('reports a missing account rather than silently succeeding', async () => {
    const writer = new IdentityAccountAvatarWriter(
      new InMemoryUserRepository(),
      new FixedClock(LATER),
    );

    const set = await writer.setAvatar('ghost', 'file-1');
    expect(!set.ok && set.error.code).toBe('identity.user_not_found');
    const cleared = await writer.clearAvatar('ghost');
    expect(!cleared.ok && cleared.error.code).toBe('identity.user_not_found');
  });
});

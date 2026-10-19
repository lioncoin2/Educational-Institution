import { err, failure, ok, type Principal, type Result } from '../../../shared';
import type { DownloadLink, FileAssetSummary, FileAssets } from '../../files/contracts/file-assets';
import type { FileKind } from '../../files/contracts/file-kind';
import type { AccountDirectory, AccountSummary } from '../../identity/contracts/account-directory';
import type { AuthorizationService } from '../../identity/contracts/authorization';
import { GetPersonAvatarLinkUseCase } from './get-person-avatar-link.use-case';

const admin: Principal = {
  userId: 'u-admin',
  roles: ['ADMIN'],
  permissions: new Set(['people.read']),
};

function auth(allowed: boolean): AuthorizationService {
  const decision: Result<void> = allowed
    ? ok(undefined)
    : err(failure('forbidden', 'identity.permission_denied', 'Not allowed.'));
  return { can: () => allowed, authorize: () => decision };
}

/** Records who was asked for, so we can prove the TARGET (not the caller) owns. */
class FakeDirectory implements AccountDirectory {
  readonly described: string[][] = [];
  constructor(private readonly people: Record<string, AccountSummary>) {}

  async describe(userIds: readonly string[]): Promise<readonly AccountSummary[]> {
    this.described.push([...userIds]);
    return userIds.map((id) => this.people[id]).filter((p): p is AccountSummary => p !== undefined);
  }

  async withPermission(): Promise<ReadonlySet<string>> {
    return new Set();
  }
}

class FakeFiles implements FileAssets {
  readonly verifyCalls: { assetId: string; ownerUserId: string; kinds: readonly FileKind[] }[] = [];
  linkCalls = 0;
  constructor(
    private readonly verifyOk: boolean,
    private readonly linkOk = true,
  ) {}

  async describe(): Promise<readonly FileAssetSummary[]> {
    return [];
  }

  async verifyAttachable(
    assetId: string,
    ownerUserId: string,
    acceptedKinds: readonly FileKind[],
  ): Promise<Result<FileAssetSummary>> {
    this.verifyCalls.push({ assetId, ownerUserId, kinds: acceptedKinds });
    return this.verifyOk
      ? ok({
          id: assetId,
          kind: 'IMAGE',
          contentType: 'image/png',
          byteSize: 10,
          displayName: 'a.png',
          durationMs: null,
          width: null,
          height: null,
        })
      : err(failure('not_found', 'files.asset_not_found', 'No such asset.'));
  }

  async createDownloadLink(assetId: string): Promise<Result<DownloadLink>> {
    this.linkCalls += 1;
    return this.linkOk
      ? ok({ url: `/files/dl/${assetId}?sig=x`, expiresAt: new Date('2026-01-01T00:05:00Z') })
      : err(failure('unavailable', 'files.storage_unavailable', 'Down.'));
  }
}

const withAvatar: AccountSummary = {
  userId: 'u-sara',
  displayName: 'سارة',
  avatarFileAssetId: 'asset-sara',
  active: true,
};
const noAvatar: AccountSummary = {
  userId: 'u-omar',
  displayName: 'عمر',
  avatarFileAssetId: null,
  active: true,
};

describe('GetPersonAvatarLinkUseCase', () => {
  it('refuses a caller without people.read, and reads neither directory nor files', async () => {
    const directory = new FakeDirectory({});
    const files = new FakeFiles(true);
    const useCase = new GetPersonAvatarLinkUseCase(auth(false), directory, files);

    const result = await useCase.execute({ principal: admin, userId: 'u-sara' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('forbidden');
    expect(directory.described).toHaveLength(0);
    expect(files.verifyCalls).toHaveLength(0);
  });

  it('mints a short-lived link for a person who has a picture', async () => {
    const directory = new FakeDirectory({ 'u-sara': withAvatar });
    const files = new FakeFiles(true);
    const useCase = new GetPersonAvatarLinkUseCase(auth(true), directory, files);

    const result = await useCase.execute({ principal: admin, userId: 'u-sara' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.url).toContain('asset-sara');
    // The TARGET must own the image — never the caller — and it must be an IMAGE.
    expect(files.verifyCalls).toEqual([
      { assetId: 'asset-sara', ownerUserId: 'u-sara', kinds: ['IMAGE'] },
    ]);
  });

  it('answers 404 (no picture) when the person has no avatar, without touching files', async () => {
    const directory = new FakeDirectory({ 'u-omar': noAvatar });
    const files = new FakeFiles(true);
    const useCase = new GetPersonAvatarLinkUseCase(auth(true), directory, files);

    const result = await useCase.execute({ principal: admin, userId: 'u-omar' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('people.person_avatar_not_found');
    expect(files.verifyCalls).toHaveLength(0);
    expect(files.linkCalls).toBe(0);
  });

  it('answers 404 for an unknown account', async () => {
    const directory = new FakeDirectory({});
    const files = new FakeFiles(true);
    const useCase = new GetPersonAvatarLinkUseCase(auth(true), directory, files);

    const result = await useCase.execute({ principal: admin, userId: 'ghost' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('people.person_avatar_not_found');
  });

  it('answers 404 when the reference no longer verifies (cleared, swapped, not an image)', async () => {
    const directory = new FakeDirectory({ 'u-sara': withAvatar });
    const files = new FakeFiles(false);
    const useCase = new GetPersonAvatarLinkUseCase(auth(true), directory, files);

    const result = await useCase.execute({ principal: admin, userId: 'u-sara' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('people.person_avatar_not_found');
    expect(files.linkCalls).toBe(0); // a stale reference never mints a link
  });

  it('answers 404 when the link itself cannot be minted', async () => {
    const directory = new FakeDirectory({ 'u-sara': withAvatar });
    const files = new FakeFiles(true, false);
    const useCase = new GetPersonAvatarLinkUseCase(auth(true), directory, files);

    const result = await useCase.execute({ principal: admin, userId: 'u-sara' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('people.person_avatar_not_found');
  });
});

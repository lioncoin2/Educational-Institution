import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { startApi, type RunningApi } from '../support/api-client';
import { sampleBytes } from '../support/files-harness';

const errorOf = (body: Record<string, unknown>) =>
  body.error as { kind?: string; code: string; message: string };

interface Account {
  readonly id: string;
  readonly token: string;
}

/**
 * Editing a community's profile over real HTTP (ADR 0037): the title,
 * description and picture, gated by `community.profile.edit`. Proves the full
 * cycle — open info, edit, save, re-read — plus the picture upload→verify→serve
 * path, and that a member without the capability is refused.
 */
describe('community profile API', () => {
  let api: RunningApi;
  let storageRoot: string;
  let owner: Account;
  let admin: Account;
  let member: Account;
  let communityId: string;

  async function provision(name: string, role: string): Promise<Account> {
    const email = `${name}@institution.test`;
    const password = `${name} passphrase long enough`;
    const created = await api.call('POST', '/admin/users', {
      token: owner.token,
      body: { displayName: name, identifier: email, initialPassword: password },
    });
    const id = created.body.id as string;
    await api.call('POST', `/admin/users/${id}/roles`, { token: owner.token, body: { role } });
    await api.call('POST', `/admin/users/${id}/status`, {
      token: owner.token,
      body: { status: 'ACTIVE' },
    });
    const login = await api.call('POST', '/auth/login', { body: { identifier: email, password } });
    return { id, token: login.body.accessToken as string };
  }

  async function uploadImage(token: string): Promise<string> {
    const bytes = sampleBytes('image/png', 256);
    const declared = await api.call('POST', '/files/uploads', {
      token,
      body: { kind: 'IMAGE', contentType: 'image/png', byteSize: bytes.length, fileName: 'c.png' },
    });
    const assetId = (declared.body.asset as { id: string }).id;
    await fetch(`${api.base}${(declared.body.upload as { url: string }).url}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });
    await api.call('POST', `/files/uploads/${assetId}/complete`, { token });
    return assetId;
  }

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'community-profile-'));
    api = await startApi({
      STORAGE_LOCAL_ROOT: storageRoot,
      STORAGE_SIGNING_SECRET: 'api-test-storage-secret-of-at-least-32-bytes',
    });
    const bootstrapped = await api.app.get(BootstrapOwnerUseCase).execute({
      displayName: 'Owner',
      identifierKind: 'email',
      identifier: 'owner@institution.test',
      password: 'owner passphrase one',
      meta: {},
    });
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.code);
    const login = await api.call('POST', '/auth/login', {
      body: { identifier: 'owner@institution.test', password: 'owner passphrase one' },
    });
    owner = { id: bootstrapped.value.id, token: login.body.accessToken as string };
    admin = await provision('admin', 'ADMIN');
    // A TEACHER: holds the communities.moderate ceiling, so as a plain member
    // (no grant, not owner) the profile-edit act is refused at the capability,
    // not at the ceiling — which is the gate this feature adds.
    member = await provision('member', 'TEACHER');

    const created = await api.call('POST', '/communities', {
      token: admin.token,
      body: { title: 'حلقة التجويد' },
    });
    expect(created.status).toBe(201);
    communityId = created.body.id as string;
    expect(created.body.description).toBeNull();
    expect(created.body.avatarFileAssetId).toBeNull();

    await api.call('POST', `/communities/${communityId}/members`, {
      token: admin.token,
      body: { userIds: [member.id] },
    });
  }, 60_000);

  afterAll(async () => {
    await api.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('edits the title and description, and the change survives a re-read', async () => {
    const edited = await api.call('PUT', `/communities/${communityId}/profile`, {
      token: admin.token,
      body: { title: 'حلقة التجويد المتقدّمة', description: '  حلقة لإتقان أحكام التجويد  ' },
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      title: 'حلقة التجويد المتقدّمة',
      description: 'حلقة لإتقان أحكام التجويد', // trimmed
    });

    const reread = await api.call('GET', `/communities/${communityId}`, { token: admin.token });
    expect(reread.body).toMatchObject({
      title: 'حلقة التجويد المتقدّمة',
      description: 'حلقة لإتقان أحكام التجويد',
    });
  });

  it('sets a picture, serves a link to it, and clears it', async () => {
    const assetId = await uploadImage(admin.token);
    const set = await api.call('PUT', `/communities/${communityId}/profile`, {
      token: admin.token,
      body: { title: 'حلقة التجويد المتقدّمة', description: null, avatarFileAssetId: assetId },
    });
    expect(set.status).toBe(200);
    expect(set.body.avatarFileAssetId).toBe(assetId);
    expect(set.body.description).toBeNull();

    // Any member who may view the community may fetch its picture.
    const link = await api.call('GET', `/communities/${communityId}/avatar`, {
      token: member.token,
    });
    expect(link.status).toBe(200);
    const fetched = await fetch(`${api.base}${link.body.url as string}`);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');

    const cleared = await api.call('PUT', `/communities/${communityId}/profile`, {
      token: admin.token,
      body: { title: 'حلقة التجويد المتقدّمة', description: null, avatarFileAssetId: null },
    });
    expect(cleared.body.avatarFileAssetId).toBeNull();
    const gone = await api.call('GET', `/communities/${communityId}/avatar`, {
      token: member.token,
    });
    expect(gone.status).toBe(404);
    expect(errorOf(gone.body).code).toBe('communities.avatar_not_found');
  });

  it('refuses a member without the capability, and a non-image picture', async () => {
    const refused = await api.call('PUT', `/communities/${communityId}/profile`, {
      token: member.token,
      body: { title: 'عنوان آخر', description: null },
    });
    expect(refused.status).toBe(403);
    expect(errorOf(refused.body).code).toBe('communities.capability_required');

    // A document the editor owns is still refused: a picture must be an image.
    const bytes = Buffer.from('%PDF-1.4\n% t\n');
    const declared = await api.call('POST', '/files/uploads', {
      token: admin.token,
      body: {
        kind: 'DOCUMENT',
        contentType: 'application/pdf',
        byteSize: bytes.length,
        fileName: 'd.pdf',
      },
    });
    const docId = (declared.body.asset as { id: string }).id;
    await fetch(`${api.base}${(declared.body.upload as { url: string }).url}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: bytes,
    });
    await api.call('POST', `/files/uploads/${docId}/complete`, { token: admin.token });
    const badAvatar = await api.call('PUT', `/communities/${communityId}/profile`, {
      token: admin.token,
      body: { title: 'حلقة التجويد المتقدّمة', description: null, avatarFileAssetId: docId },
    });
    expect(badAvatar.status).toBe(422);
    expect(errorOf(badAvatar.body).code).toBe('communities.avatar_invalid');
  });
});

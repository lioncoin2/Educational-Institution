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
 * The profile-picture cycle over real HTTP: upload an image through the files
 * flow, point the account at it, see the reference on `/auth/me`, mint a
 * short-lived link to one's own asset, and clear it again. Also proves the two
 * refusals that keep one account's picture from leaking: an asset the caller
 * does not own, and a non-image asset.
 */
describe('profile avatar API', () => {
  let api: RunningApi;
  let storageRoot: string;
  let owner: Account;
  let student: Account;
  let other: Account;

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

  /** Declare → PUT → complete, as a client would; returns the asset id. */
  async function uploadImage(token: string, size = 256): Promise<string> {
    const bytes = sampleBytes('image/png', size);
    const declared = await api.call('POST', '/files/uploads', {
      token,
      body: {
        kind: 'IMAGE',
        contentType: 'image/png',
        byteSize: bytes.length,
        fileName: 'pic.png',
      },
    });
    expect(declared.status).toBe(201);
    const upload = declared.body.upload as { url: string };
    const assetId = (declared.body.asset as { id: string }).id;
    const put = await fetch(`${api.base}${upload.url}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });
    expect(put.status).toBe(201);
    const completed = await api.call('POST', `/files/uploads/${assetId}/complete`, { token });
    expect(completed.status).toBe(200);
    return assetId;
  }

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'avatar-storage-'));
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
    student = await provision('student', 'STUDENT');
    other = await provision('other', 'STUDENT');
  }, 60_000);

  afterAll(async () => {
    await api.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('starts with no avatar on /auth/me', async () => {
    const me = await api.call('GET', '/auth/me', { token: student.token });
    expect(me.status).toBe(200);
    expect(me.body.avatarFileAssetId).toBeNull();
  });

  it('sets, reflects, links and clears the account picture', async () => {
    const assetId = await uploadImage(student.token);

    const set = await api.call('PUT', '/files/me/avatar', {
      token: student.token,
      body: { fileAssetId: assetId },
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ id: assetId, kind: 'IMAGE' });

    const me = await api.call('GET', '/auth/me', { token: student.token });
    expect(me.body.avatarFileAssetId).toBe(assetId);

    const link = await api.call('POST', `/files/me/assets/${assetId}/link`, {
      token: student.token,
    });
    expect(link.status).toBe(200);
    expect(typeof link.body.url).toBe('string');
    expect(typeof link.body.expiresAt).toBe('string');
    // The minted link really serves the bytes.
    const fetched = await fetch(`${api.base}${link.body.url as string}`);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');

    const cleared = await api.call('DELETE', '/files/me/avatar', { token: student.token });
    expect(cleared.status).toBe(204);
    const after = await api.call('GET', '/auth/me', { token: student.token });
    expect(after.body.avatarFileAssetId).toBeNull();
  });

  it('refuses to set an avatar to an asset the caller does not own', async () => {
    const othersAsset = await uploadImage(other.token);
    const set = await api.call('PUT', '/files/me/avatar', {
      token: student.token,
      body: { fileAssetId: othersAsset },
    });
    expect(set.status).toBe(404);
    expect(errorOf(set.body).code).toBe('files.asset_not_found');
  });

  it('refuses a link to an asset the caller does not own', async () => {
    const othersAsset = await uploadImage(other.token);
    const link = await api.call('POST', `/files/me/assets/${othersAsset}/link`, {
      token: student.token,
    });
    expect(link.status).toBe(404);
    expect(errorOf(link.body).code).toBe('files.asset_not_found');
  });

  it('refuses to set an avatar to a non-image asset', async () => {
    const bytes = Buffer.from('%PDF-1.4\n% test pdf\n');
    const declared = await api.call('POST', '/files/uploads', {
      token: student.token,
      body: {
        kind: 'DOCUMENT',
        contentType: 'application/pdf',
        byteSize: bytes.length,
        fileName: 'doc.pdf',
      },
    });
    const upload = declared.body.upload as { url: string };
    const docId = (declared.body.asset as { id: string }).id;
    await fetch(`${api.base}${upload.url}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: bytes,
    });
    await api.call('POST', `/files/uploads/${docId}/complete`, { token: student.token });

    const set = await api.call('PUT', '/files/me/avatar', {
      token: student.token,
      body: { fileAssetId: docId },
    });
    expect(set.status).toBe(422);
    expect(errorOf(set.body).code).toBe('files.asset_kind_not_accepted');
  });

  it('requires authentication on every /files/me route', async () => {
    for (const [method, path] of [
      ['PUT', '/files/me/avatar'],
      ['DELETE', '/files/me/avatar'],
      ['POST', '/files/me/assets/x/link'],
    ] as const) {
      const response = await api.call(method, path, { body: { fileAssetId: 'x' } });
      expect(response.status).toBe(401);
    }
  });
});

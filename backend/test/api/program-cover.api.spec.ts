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
 * A program's cover image over real HTTP (ADR 0038, mirroring the community
 * avatar): bind, serve a short-lived link, replace and clear — gated by
 * `academic.manage` for changes and `academic.read` for the link. Proves the
 * full upload→verify→serve path, that an existing program without a cover
 * reads as null, that a non-manager cannot set one, and that a non-image is
 * refused. The image is stored and served by files; academic holds the id.
 */
describe('program cover image API', () => {
  let api: RunningApi;
  let storageRoot: string;
  let owner: Account;
  let admin: Account;
  let student: Account;
  let programId: string;

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

  async function upload(
    token: string,
    kind: 'IMAGE' | 'DOCUMENT',
    contentType: string,
    fileName: string,
  ): Promise<string> {
    const bytes = sampleBytes(contentType, 256);
    const declared = await api.call('POST', '/files/uploads', {
      token,
      body: { kind, contentType, byteSize: bytes.length, fileName },
    });
    const assetId = (declared.body.asset as { id: string }).id;
    await fetch(`${api.base}${(declared.body.upload as { url: string }).url}`, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: bytes,
    });
    await api.call('POST', `/files/uploads/${assetId}/complete`, { token });
    return assetId;
  }

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'program-cover-'));
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
    // A STUDENT: holds academic.read (may see the catalogue and a cover link) but
    // not academic.manage, so may not set or clear a cover.
    student = await provision('student', 'STUDENT');

    const section = await api.call('POST', '/academic/sections', {
      token: admin.token,
      body: { code: 'cover-sec', name: 'قسم الأغلفة', kind: 'SPECIAL', order: 1 },
    });
    expect(section.status).toBe(201);
    const program = await api.call('POST', '/academic/programs', {
      token: admin.token,
      body: {
        sectionId: section.body.id as string,
        code: 'cover-prog',
        name: 'برنامج الغلاف',
        order: 1,
      },
    });
    expect(program.status).toBe(201);
    programId = program.body.id as string;
    // A brand-new program carries no cover.
    expect(program.body.coverFileAssetId).toBeNull();
  }, 60_000);

  afterAll(async () => {
    await api.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('a program with no cover reads as null, in the catalogue and the detail', async () => {
    const detail = await api.call('GET', `/academic/programs/${programId}`, {
      token: student.token,
    });
    expect(detail.status).toBe(200);
    expect(
      (detail.body.program as { coverFileAssetId: string | null }).coverFileAssetId,
    ).toBeNull();
    // No cover → the cover link route says so.
    const noCover = await api.call('GET', `/academic/programs/${programId}/cover`, {
      token: student.token,
    });
    expect([noCover.status, errorOf(noCover.body).code]).toEqual([
      404,
      'academic.program_cover_not_found',
    ]);
  });

  it('binds a cover, serves a link, replaces it, and clears it', async () => {
    const assetId = await upload(admin.token, 'IMAGE', 'image/png', 'cover.png');
    const set = await api.call('PUT', `/academic/programs/${programId}/cover`, {
      token: admin.token,
      body: { coverFileAssetId: assetId },
    });
    expect(set.status).toBe(200);
    expect(set.body.coverFileAssetId).toBe(assetId);

    // Any reader of the catalogue (a student here) may fetch the cover image.
    const link = await api.call('GET', `/academic/programs/${programId}/cover`, {
      token: student.token,
    });
    expect(link.status).toBe(200);
    const fetched = await fetch(`${api.base}${link.body.url as string}`);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');

    // Replacing the cover points at the new asset.
    const second = await upload(admin.token, 'IMAGE', 'image/png', 'cover2.png');
    const replaced = await api.call('PUT', `/academic/programs/${programId}/cover`, {
      token: admin.token,
      body: { coverFileAssetId: second },
    });
    expect(replaced.body.coverFileAssetId).toBe(second);

    // Clearing it (DELETE) removes the reference; the link route 404s again.
    const cleared = await api.call('DELETE', `/academic/programs/${programId}/cover`, {
      token: admin.token,
    });
    expect([cleared.status, cleared.body.coverFileAssetId]).toEqual([200, null]);
    const gone = await api.call('GET', `/academic/programs/${programId}/cover`, {
      token: student.token,
    });
    expect([gone.status, errorOf(gone.body).code]).toEqual([
      404,
      'academic.program_cover_not_found',
    ]);
  });

  it('refuses a non-manager setting a cover, and a non-image cover', async () => {
    // A student holds academic.read but not academic.manage.
    const ownImage = await upload(student.token, 'IMAGE', 'image/png', 's.png');
    const refusedRole = await api.call('PUT', `/academic/programs/${programId}/cover`, {
      token: student.token,
      body: { coverFileAssetId: ownImage },
    });
    expect([refusedRole.status, errorOf(refusedRole.body).code]).toEqual([
      403,
      'identity.permission_denied',
    ]);

    // A document is not an image: files' own check refuses it.
    const pdf = await upload(admin.token, 'DOCUMENT', 'application/pdf', 'notes.pdf');
    const refusedKind = await api.call('PUT', `/academic/programs/${programId}/cover`, {
      token: admin.token,
      body: { coverFileAssetId: pdf },
    });
    expect([refusedKind.status, errorOf(refusedKind.body).code]).toEqual([
      422,
      'academic.program_cover_invalid',
    ]);
    // Nothing was bound by either refusal.
    const detail = await api.call('GET', `/academic/programs/${programId}`, { token: admin.token });
    expect(
      (detail.body.program as { coverFileAssetId: string | null }).coverFileAssetId,
    ).toBeNull();
  });

  it('refuses a cover on a program that does not exist, and a malformed body', async () => {
    const image = await upload(admin.token, 'IMAGE', 'image/png', 'x.png');
    const unknown = await api.call('PUT', '/academic/programs/does-not-exist/cover', {
      token: admin.token,
      body: { coverFileAssetId: image },
    });
    expect([unknown.status, errorOf(unknown.body).code]).toEqual([
      404,
      'academic.program_not_found',
    ]);
    expect(
      (
        await api.call('PUT', `/academic/programs/${programId}/cover`, {
          token: admin.token,
          body: { coverFileAssetId: '' },
        })
      ).status,
    ).toBe(400);
  });
});

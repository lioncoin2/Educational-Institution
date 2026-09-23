import {
  filesHarness,
  sampleBytes,
  splitUrl,
  type FilesHarness,
} from '../../../../test/support/files-harness';
import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import { principalWith } from '../../../../test/support/principals';
import { Roles } from '../../identity/domain/role';
import { UPLOAD_REQUESTS_PER_USER } from './files-policy';

const teacher = principalWith('teacher-1', [Roles.teacher]);
const student = principalWith('student-1', [Roles.student]);
const supervisor = principalWith('supervisor-1', [Roles.supervisor]);

const PNG = { kind: 'IMAGE', contentType: 'image/png', fileName: 'board.png' } as const;

describe('uploading a file', () => {
  let h: FilesHarness;

  beforeEach(async () => {
    h = await filesHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  const request = (principal = teacher, byteSize = 64) =>
    h.requestUpload.execute({ principal, declaration: { ...PNG, byteSize } });

  it('declares, transfers and verifies an upload into an attachable asset', async () => {
    const ticket = expectOk(await request());
    expect(ticket.asset).toMatchObject({ status: 'PENDING', kind: 'IMAGE', byteSize: 64 });
    expect(ticket.upload).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
    });

    await expect(h.put(ticket.upload.url, sampleBytes('image/png', 64))).resolves.toBe('written');
    const asset = expectOk(
      await h.completeUpload.execute({ principal: teacher, assetId: ticket.asset.id }),
    );
    expect(asset).toEqual({
      id: ticket.asset.id,
      kind: 'IMAGE',
      contentType: 'image/png',
      byteSize: 64,
      displayName: 'board.png',
      durationMs: null,
      width: null,
      height: null,
    });
  });

  it('refuses anyone without files.upload', async () => {
    expect(expectErr(await request(supervisor)).code).toBe('identity.permission_denied');
    expect(expectOk(await request(student)).asset.status).toBe('PENDING');
  });

  it('refuses a declaration the policy does not allow, before any URL exists', async () => {
    const result = await h.requestUpload.execute({
      principal: teacher,
      declaration: { kind: 'IMAGE', contentType: 'text/html', byteSize: 10, fileName: 'x.html' },
    });
    expect(expectErr(result).code).toBe('files.content_type_not_allowed');
  });

  it('limits how many uploads one person may start', async () => {
    for (let i = 0; i < UPLOAD_REQUESTS_PER_USER.limit; i++) expectOk(await request());
    const refused = expectErr(await request());
    expect(refused).toMatchObject({ kind: 'rate_limited', code: 'files.too_many_uploads' });
    // Another person is unaffected.
    expectOk(await request(student));
  });

  it('never lets a transfer exceed the declared size', async () => {
    const ticket = expectOk(await request(teacher, 64));
    await expect(h.put(ticket.upload.url, sampleBytes('image/png', 65))).resolves.toBe('too_large');
  });

  it('upload links expire', async () => {
    const ticket = expectOk(await request());
    h.clock.advance(15 * 60);
    await expect(h.put(ticket.upload.url, sampleBytes('image/png', 64))).resolves.toBe(
      'link_invalid',
    );
  });
});

describe('completing an upload — the claim is checked, not believed', () => {
  let h: FilesHarness;

  beforeEach(async () => {
    h = await filesHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  async function started(byteSize = 64) {
    return expectOk(
      await h.requestUpload.execute({ principal: teacher, declaration: { ...PNG, byteSize } }),
    );
  }
  const complete = (assetId: string, principal = teacher) =>
    h.completeUpload.execute({ principal, assetId });

  it('refuses to complete before the bytes arrived', async () => {
    const ticket = await started();
    expect(expectErr(await complete(ticket.asset.id))).toMatchObject({
      kind: 'precondition_failed',
      code: 'files.upload_missing',
    });
  });

  it("reports someone else's upload exactly like a missing one", async () => {
    const ticket = await started();
    await h.put(ticket.upload.url, sampleBytes('image/png', 64));
    const other = principalWith('teacher-2', [Roles.teacher]);
    expect(expectErr(await complete(ticket.asset.id, other)).code).toBe('files.asset_not_found');
    expect(expectErr(await complete('no-such-asset')).code).toBe('files.asset_not_found');
  });

  // An HTML page uploaded as "image/png" would be served back as whatever a
  // browser sniffed it to be. The magic bytes stop it here.
  it('rejects bytes that are not what was declared, and deletes them', async () => {
    const ticket = await started(64);
    const html = Buffer.alloc(64, 0x20);
    Buffer.from('<!DOCTYPE html><script>alert(1)</script>').copy(html);
    await h.put(ticket.upload.url, html);

    expect(expectErr(await complete(ticket.asset.id))).toMatchObject({
      kind: 'validation',
      code: 'files.content_mismatch',
    });
    const stored = await h.assets.findById(ticket.asset.id as never);
    expect(stored?.status).toBe('REJECTED');
    await expect(h.storage.stat(stored!.storageKey)).resolves.toBeNull();
    // A rejected upload stays rejected.
    expect(expectErr(await complete(ticket.asset.id)).code).toBe('files.upload_rejected');
  });

  it('rejects an object smaller than declared', async () => {
    const ticket = await started(64);
    await h.put(ticket.upload.url, sampleBytes('image/png', 40));
    expect(expectErr(await complete(ticket.asset.id)).code).toBe('files.content_mismatch');
  });

  it('is idempotent, and exactly-once under concurrent completion', async () => {
    const ticket = await started();
    await h.put(ticket.upload.url, sampleBytes('image/png', 64));
    const [a, b] = await Promise.all([complete(ticket.asset.id), complete(ticket.asset.id)]);
    expect(expectOk(a)).toEqual(expectOk(b));
    expect(expectOk(await complete(ticket.asset.id)).id).toBe(ticket.asset.id);
  });

  it('never accepts a second transfer to the same key', async () => {
    const ticket = await started();
    await h.put(ticket.upload.url, sampleBytes('image/png', 64));
    await expect(h.put(ticket.upload.url, sampleBytes('image/png', 64))).resolves.toBe('exists');
  });
});

describe('FileAssets — the contract other modules use', () => {
  let h: FilesHarness;

  beforeEach(async () => {
    h = await filesHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('lets only the uploader attach a file, only once verified, only of an accepted kind', async () => {
    const asset = await h.upload(teacher, PNG);
    expect(
      expectOk(await h.fileAssets.verifyAttachable(asset.id, teacher.userId, ['IMAGE'])).id,
    ).toBe(asset.id);
    expect(
      expectErr(await h.fileAssets.verifyAttachable(asset.id, student.userId, ['IMAGE'])).code,
    ).toBe('files.asset_not_found');
    expect(
      expectErr(await h.fileAssets.verifyAttachable(asset.id, teacher.userId, ['VOICE'])).code,
    ).toBe('files.asset_kind_not_accepted');

    const pending = expectOk(
      await h.requestUpload.execute({ principal: teacher, declaration: { ...PNG, byteSize: 64 } }),
    );
    expect(
      expectErr(await h.fileAssets.verifyAttachable(pending.asset.id, teacher.userId, ['IMAGE']))
        .code,
    ).toBe('files.asset_not_ready');
  });

  it('describes available assets only', async () => {
    const asset = await h.upload(teacher, PNG);
    const pending = expectOk(
      await h.requestUpload.execute({ principal: teacher, declaration: { ...PNG, byteSize: 64 } }),
    );
    const described = await h.fileAssets.describe([
      asset.id,
      pending.asset.id,
      'missing',
      asset.id,
    ]);
    expect(described.map((a) => a.id)).toEqual([asset.id]);
    await expect(h.fileAssets.describe([])).resolves.toEqual([]);
  });

  it('mints a short-lived download link bound to the right response', async () => {
    const image = await h.upload(teacher, PNG);
    const document = await h.upload(teacher, {
      kind: 'DOCUMENT',
      contentType: 'application/pdf',
      fileName: 'homework.pdf',
    });

    const link = expectOk(await h.fileAssets.createDownloadLink(image.id));
    expect(link.expiresAt.getTime() - h.clock.now().getTime()).toBe(5 * 60 * 1000);
    const { token, query } = splitUrl(link.url);
    expect(h.storage.verifyDownload(token, query)).toMatchObject({
      contentType: 'image/png',
      disposition: 'inline',
      fileName: 'board.png',
    });

    // A document is never rendered in place.
    const pdf = splitUrl(expectOk(await h.fileAssets.createDownloadLink(document.id)).url);
    expect(h.storage.verifyDownload(pdf.token, pdf.query)?.disposition).toBe('attachment');

    h.clock.advance(5 * 60);
    expect(h.storage.verifyDownload(token, query)).toBeNull();
  });

  it('mints no link for an unknown or unverified asset', async () => {
    const pending = expectOk(
      await h.requestUpload.execute({ principal: teacher, declaration: { ...PNG, byteSize: 64 } }),
    );
    expect(expectErr(await h.fileAssets.createDownloadLink(pending.asset.id)).code).toBe(
      'files.asset_not_found',
    );
    expect(expectErr(await h.fileAssets.createDownloadLink('missing')).code).toBe(
      'files.asset_not_found',
    );
  });
});

import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import type { Clock } from '../../../shared';
import { LocalStorageProvider } from './local-storage-provider';

const SECRET = 'test-only-storage-signing-secret-of-32-bytes';
const KEY = 'image/2026/09/0b6f3c1e-8f6a-4f57-9a41-5a1c2f0e9d11';
const OTHER_KEY = 'image/2026/09/7d2c9a55-1f3e-4a8b-b0c4-3e9f1d2a6b70';

class FixedClock implements Clock {
  constructor(public at = new Date('2026-09-01T08:00:00Z')) {}
  now(): Date {
    return this.at;
  }
}

function parse(url: string): { token: string; query: Record<string, string> } {
  const parsed = new URL(url, 'http://api.test');
  return {
    token: parsed.pathname.split('/').pop() ?? '',
    query: Object.fromEntries(parsed.searchParams.entries()),
  };
}

describe('LocalStorageProvider', () => {
  let root: string;
  let clock: FixedClock;
  let storage: LocalStorageProvider;
  const inFiveMinutes = () => new Date(clock.now().getTime() + 5 * 60 * 1000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'local-storage-'));
    clock = new FixedClock();
    storage = new LocalStorageProvider(root, SECRET, clock);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const uploadUrl = (key = KEY, maxBytes = 100) =>
    storage.createUploadTarget({
      storageKey: key,
      contentType: 'image/png',
      maxBytes,
      expiresAt: inFiveMinutes(),
    });
  const downloadUrl = (key = KEY) =>
    storage.createDownloadUrl({
      storageKey: key,
      contentType: 'image/png',
      fileName: 'صورة.png',
      disposition: 'inline',
      expiresAt: inFiveMinutes(),
    });

  describe('signed URLs', () => {
    it('issues an upload target bound to key, type and size ceiling', async () => {
      const target = await uploadUrl();
      expect(target.method).toBe('PUT');
      expect(target.headers).toEqual({ 'content-type': 'image/png' });
      // The key travels as one opaque segment: no slashes to route or traverse.
      expect(target.url).toMatch(/^\/files\/local\/[A-Za-z0-9_-]+\?/);
      const { token, query } = parse(target.url);
      expect(storage.verifyUpload(token, query)).toEqual({
        storageKey: KEY,
        contentType: 'image/png',
        maxBytes: 100,
      });
    });

    it('verifies a download URL it issued, with the exact response parameters', async () => {
      const { token, query } = parse(await downloadUrl());
      expect(storage.verifyDownload(token, query)).toMatchObject({
        storageKey: KEY,
        contentType: 'image/png',
        disposition: 'inline',
        fileName: 'صورة.png',
      });
    });

    // The Foundation's signature covered only key and expiry: anyone holding a
    // download link could PUT over the file.
    it('never accepts a download link as an upload, nor the reverse', async () => {
      const download = parse(await downloadUrl());
      expect(storage.verifyUpload(download.token, { ...download.query, max: '100' })).toBeNull();
      const upload = parse((await uploadUrl()).url);
      expect(
        storage.verifyDownload(upload.token, { ...upload.query, cd: 'inline', fn: 'x.png' }),
      ).toBeNull();
    });

    it.each([
      ['the content type', { ct: 'text/html' }],
      ['the size ceiling', { max: '999999999' }],
      ['the expiry', { exp: '9999999999' }],
      ['the signature', { sig: 'A'.repeat(43) }],
    ])('refuses an upload URL whose %s was edited', async (_label, edit) => {
      const { token, query } = parse((await uploadUrl()).url);
      expect(storage.verifyUpload(token, { ...query, ...edit })).toBeNull();
    });

    it.each([
      ['the disposition', { cd: 'attachment' }],
      ['the file name', { fn: 'other.png' }],
      ['the content type', { ct: 'text/html' }],
    ])('refuses a download URL whose %s was edited', async (_label, edit) => {
      const { token, query } = parse(await downloadUrl());
      expect(storage.verifyDownload(token, { ...query, ...edit })).toBeNull();
    });

    it('refuses a signature presented for a different key', async () => {
      const { query } = parse(await downloadUrl());
      const other = parse(await downloadUrl(OTHER_KEY));
      expect(storage.verifyDownload(other.token, query)).toBeNull();
    });

    it('refuses a link once it has expired', async () => {
      const { token, query } = parse(await downloadUrl());
      clock.at = new Date(clock.now().getTime() + 5 * 60 * 1000);
      expect(storage.verifyDownload(token, query)).toBeNull();
    });

    it('refuses a link signed with another key', async () => {
      const { token, query } = parse(await downloadUrl());
      const impostor = new LocalStorageProvider(root, `${SECRET}-other`, clock);
      expect(impostor.verifyDownload(token, query)).toBeNull();
    });

    it('refuses repeated or missing parameters', async () => {
      const { token, query } = parse(await downloadUrl());
      expect(storage.verifyDownload(token, { ...query, sig: [query.sig, query.sig] })).toBeNull();
      const { fn: _dropped, ...withoutName } = query;
      expect(storage.verifyDownload(token, withoutName)).toBeNull();
    });
  });

  describe('storage keys', () => {
    // Keys are generated from ids, but traversal must be impossible regardless.
    it.each([
      '../../etc/passwd',
      'image/2026/09/../../../../etc/passwd',
      '/etc/passwd',
      'image/2026/09/a/b',
      'image/2026/09/a.png',
      'script/2026/09/abc',
    ])('refuses the malformed key %j', async (key) => {
      await expect(storage.stat(key)).resolves.toBeNull();
      await expect(storage.delete(key)).rejects.toThrow(/Malformed storage key/);
      await expect(storage.writeOnce(key, Readable.from([Buffer.from('x')]), 10)).rejects.toThrow(
        /Malformed storage key/,
      );
    });

    it('refuses a URL token that decodes to anything but a well-formed key', async () => {
      const { query } = parse(await downloadUrl());
      const traversal = Buffer.from('../../etc/passwd').toString('base64url');
      expect(storage.verifyDownload(traversal, query)).toBeNull();
      expect(storage.verifyDownload('not/a/token', query)).toBeNull();
    });
  });

  describe('writes', () => {
    it('streams an object into place, and reports what it stored', async () => {
      const bytes = Buffer.from('0123456789');
      await expect(storage.writeOnce(KEY, Readable.from([bytes]), 10)).resolves.toBe('written');
      await expect(storage.stat(KEY)).resolves.toEqual({ byteSize: 10 });
      expect(Buffer.from(await storage.readHead(KEY, 4)).toString()).toBe('0123');
    });

    // Write-once: a leaked upload link cannot replace a file after the fact.
    it('never overwrites an existing object', async () => {
      await storage.writeOnce(KEY, Readable.from([Buffer.from('original')]), 100);
      await expect(
        storage.writeOnce(KEY, Readable.from([Buffer.from('replacement')]), 100),
      ).resolves.toBe('exists');
      expect((await readFile(join(root, KEY))).toString()).toBe('original');
    });

    it('cuts an upload off past its ceiling and stores nothing', async () => {
      const chunks = [Buffer.alloc(6), Buffer.alloc(6)];
      await expect(storage.writeOnce(KEY, Readable.from(chunks), 10)).resolves.toBe('too_large');
      await expect(storage.stat(KEY)).resolves.toBeNull();
      // No temporary file is left behind either.
      expect(await readdir(join(root, 'image/2026/09'))).toEqual([]);
    });

    it('treats a client that goes away mid-upload as incomplete, and stores nothing', async () => {
      // Sends one chunk, then the connection drops — as a request would.
      let sent = false;
      const source = new Readable({
        read() {
          if (sent) this.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
          else this.push(Buffer.alloc(4));
          sent = true;
        },
      });
      await expect(storage.writeOnce(KEY, source, 100)).resolves.toBe('incomplete');
      await expect(storage.stat(KEY)).resolves.toBeNull();
    });

    it('deletes, and deleting twice is harmless', async () => {
      await storage.writeOnce(KEY, Readable.from([Buffer.from('x')]), 10);
      await storage.delete(KEY);
      await storage.delete(KEY);
      await expect(storage.stat(KEY)).resolves.toBeNull();
    });
  });

  describe('reads', () => {
    beforeEach(async () => {
      await storage.writeOnce(KEY, Readable.from([Buffer.from('0123456789')]), 10);
    });

    it('streams all of an object, or an inclusive byte range of it', async () => {
      const whole = await storage.openRead(KEY);
      expect(whole?.byteSize).toBe(10);
      expect((await buffer(whole!.stream())).toString()).toBe('0123456789');

      const part = await storage.openRead(KEY);
      expect((await buffer(part!.stream({ start: 2, end: 4 }))).toString()).toBe('234');
    });

    it('reports a missing object as absent', async () => {
      await expect(storage.openRead(OTHER_KEY)).resolves.toBeNull();
      await expect(storage.stat(OTHER_KEY)).resolves.toBeNull();
    });

    it('does not serve a directory planted at a key', async () => {
      await rm(join(root, KEY));
      await mkdir(join(root, KEY));
      await expect(storage.openRead(KEY)).resolves.toBeNull();
      await expect(storage.stat(KEY)).resolves.toBeNull();
    });
  });
});

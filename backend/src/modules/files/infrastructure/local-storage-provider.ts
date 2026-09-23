import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Clock } from '../../../shared';
import type {
  DownloadSpec,
  StorageProvider,
  StoredObject,
  UploadSpec,
  UploadTarget,
} from '../domain/storage-provider';

/** Storage keys look exactly like buildStorageKey() makes them, or they are refused. */
const STORAGE_KEY_SHAPE = /^(image|voice|audio|document)\/\d{4}\/\d{2}\/[A-Za-z0-9-]{1,64}$/;

/**
 *   written     stored; the key now holds these bytes for good
 *   too_large   more than the ceiling arrived; nothing was stored
 *   exists      the key already holds an object; nothing was changed
 *   incomplete  the client went away mid-upload; nothing was stored
 */
export type WriteOutcome = 'written' | 'too_large' | 'exists' | 'incomplete';

/** An open stored object. Stream it, or close it — one or the other. */
export interface OpenedObject {
  readonly byteSize: number;
  /** Streams bytes [start, end] inclusive, or all of them; closes the file when done. */
  stream(range?: { readonly start: number; readonly end: number }): Readable;
  close(): Promise<void>;
}

export interface VerifiedUpload {
  readonly storageKey: string;
  readonly contentType: string;
  readonly maxBytes: number;
}

export interface VerifiedDownload {
  readonly storageKey: string;
  readonly contentType: string;
  readonly disposition: 'inline' | 'attachment';
  readonly fileName: string;
  readonly expiresAt: Date;
}

class TooLarge extends Error {}

/**
 * Filesystem storage for development and single-node deployments, emulating
 * an object store's signed-URL contract — including its HTTP surface, which
 * is `local-transfer.controller.ts`. An S3 adapter needs no controller: S3
 * serves the URLs itself.
 *
 * Signatures are PURPOSE-BOUND. The signed string names the method and every
 * parameter that shapes the transfer:
 *
 *   upload    ["v1", "PUT", key, expires, contentType, maxBytes]
 *   download  ["v1", "GET", key, expires, contentType, disposition, fileName]
 *
 * so a download link cannot be replayed as an upload (the Foundation's
 * signature covered only key and expiry, which let anyone holding a download
 * link overwrite the file), and no signed parameter can be edited in the URL.
 * The array is JSON-encoded, so no value can smuggle a separator.
 *
 * The signing key is its own secret (STORAGE_SIGNING_SECRET), not the JWT
 * key: one key, one purpose — and rotating either leaves the other alone.
 *
 * Writes are write-once: bytes stream to a temporary file (never buffered in
 * memory), are cut off past the ceiling, and are linked into place only if
 * nothing is there yet.
 */
export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(
    root: string,
    private readonly signingSecret: string,
    private readonly clock: Clock,
    private readonly basePath = '/files/local',
  ) {
    this.root = resolve(root);
  }

  async createUploadTarget(spec: UploadSpec): Promise<UploadTarget> {
    const exp = String(seconds(spec.expiresAt));
    const max = String(spec.maxBytes);
    const sig = this.sign(['PUT', spec.storageKey, exp, spec.contentType, max]);
    const query = new URLSearchParams({ exp, ct: spec.contentType, max, sig });
    return {
      url: `${this.basePath}/${tokenFor(spec.storageKey)}?${query.toString()}`,
      method: 'PUT',
      headers: { 'content-type': spec.contentType },
      expiresAt: spec.expiresAt,
    };
  }

  async createDownloadUrl(spec: DownloadSpec): Promise<string> {
    const exp = String(seconds(spec.expiresAt));
    const sig = this.sign([
      'GET',
      spec.storageKey,
      exp,
      spec.contentType,
      spec.disposition,
      spec.fileName,
    ]);
    const query = new URLSearchParams({
      exp,
      ct: spec.contentType,
      cd: spec.disposition,
      fn: spec.fileName,
      sig,
    });
    return `${this.basePath}/${tokenFor(spec.storageKey)}?${query.toString()}`;
  }

  async stat(storageKey: string): Promise<StoredObject | null> {
    try {
      const stats = await stat(this.pathFor(storageKey));
      return stats.isFile() ? { byteSize: stats.size } : null;
    } catch {
      return null;
    }
  }

  async readHead(storageKey: string, byteCount: number): Promise<Uint8Array> {
    const handle = await open(this.pathFor(storageKey), 'r');
    try {
      const buffer = Buffer.alloc(byteCount);
      const { bytesRead } = await handle.read(buffer, 0, byteCount, 0);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async delete(storageKey: string): Promise<void> {
    await rm(this.pathFor(storageKey), { force: true });
  }

  // ── The local adapter's own transfer surface ────────────────────────────

  /** The upload a signed URL permits, or null for anything invalid, altered or expired. */
  verifyUpload(token: string, query: Readonly<Record<string, unknown>>): VerifiedUpload | null {
    const storageKey = keyFromToken(token);
    const { exp, ct, max, sig } = strings(query, ['exp', 'ct', 'max', 'sig']);
    if (storageKey === null || exp === null || ct === null || max === null || sig === null)
      return null;
    if (!this.live(exp) || !this.verify(['PUT', storageKey, exp, ct, max], sig)) return null;
    const maxBytes = Number(max);
    return Number.isSafeInteger(maxBytes) && maxBytes > 0
      ? { storageKey, contentType: ct, maxBytes }
      : null;
  }

  verifyDownload(token: string, query: Readonly<Record<string, unknown>>): VerifiedDownload | null {
    const storageKey = keyFromToken(token);
    const { exp, ct, cd, fn, sig } = strings(query, ['exp', 'ct', 'cd', 'fn', 'sig']);
    if (
      storageKey === null ||
      exp === null ||
      ct === null ||
      cd === null ||
      fn === null ||
      sig === null
    ) {
      return null;
    }
    if (cd !== 'inline' && cd !== 'attachment') return null;
    if (!this.live(exp) || !this.verify(['GET', storageKey, exp, ct, cd, fn], sig)) return null;
    return {
      storageKey,
      contentType: ct,
      disposition: cd,
      fileName: fn,
      expiresAt: new Date(Number(exp) * 1000),
    };
  }

  /** Streams to disk, never to memory; refuses to overwrite; cuts off past `maxBytes`. */
  async writeOnce(storageKey: string, source: Readable, maxBytes: number): Promise<WriteOutcome> {
    const target = this.pathFor(storageKey);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.upload-${randomUUID()}`;

    let written = 0;
    const ceiling = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written += chunk.length;
        done(written > maxBytes ? new TooLarge() : null, chunk);
      },
    });

    try {
      await pipeline(source, ceiling, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      // link() fails if the target exists: write-once, atomically.
      await link(temporary, target);
      return 'written';
    } catch (error) {
      if (error instanceof TooLarge) return 'too_large';
      const code = (error as { code?: string }).code;
      if (code === 'EEXIST') return 'exists';
      if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE') return 'incomplete';
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /**
   * Opens the object once and reads size and bytes through the same handle,
   * so a delete between "how big is it" and "send it" cannot split the two.
   */
  async openRead(storageKey: string): Promise<OpenedObject | null> {
    let handle: FileHandle;
    try {
      handle = await open(this.pathFor(storageKey), 'r');
    } catch {
      return null;
    }
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      return null;
    }
    return {
      byteSize: stats.size,
      stream: (range) => handle.createReadStream(range === undefined ? {} : { ...range }),
      close: () => handle.close(),
    };
  }

  private sign(parts: readonly string[]): string {
    return createHmac('sha256', this.signingSecret)
      .update(JSON.stringify(['v1', ...parts]))
      .digest('base64url');
  }

  private verify(parts: readonly string[], signature: string): boolean {
    const expected = Buffer.from(this.sign(parts));
    const provided = Buffer.from(signature);
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  private live(exp: string): boolean {
    if (!/^\d{1,12}$/.test(exp)) return false;
    return Number(exp) > seconds(this.clock.now());
  }

  /** Resolves a key inside the root, refusing any key that is malformed or escapes it. */
  private pathFor(storageKey: string): string {
    if (!STORAGE_KEY_SHAPE.test(storageKey)) throw new Error('Malformed storage key.');
    const candidate = resolve(join(this.root, storageKey));
    if (!candidate.startsWith(this.root + sep))
      throw new Error('Storage key escapes the storage root.');
    return candidate;
  }
}

function seconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

/** The URL carries the key as one opaque segment — no slashes to route or traverse. */
function tokenFor(storageKey: string): string {
  return Buffer.from(storageKey, 'utf8').toString('base64url');
}

function keyFromToken(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(token)) return null;
  const key = Buffer.from(token, 'base64url').toString('utf8');
  return STORAGE_KEY_SHAPE.test(key) ? key : null;
}

function strings<K extends string>(
  query: Readonly<Record<string, unknown>>,
  keys: readonly K[],
): Record<K, string | null> {
  const out = {} as Record<K, string | null>;
  for (const key of keys) {
    const value = query[key];
    out[key] = typeof value === 'string' && value.length > 0 && value.length <= 2048 ? value : null;
  }
  return out;
}

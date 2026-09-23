import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { InMemoryRateLimiter } from '../../src/platform/rate-limit/in-memory-rate-limiter';
import type { Principal } from '../../src/shared';
import { CompleteUploadUseCase } from '../../src/modules/files/application/complete-upload.use-case';
import { FileAssetsService } from '../../src/modules/files/application/file-assets.service';
import { RequestUploadUseCase } from '../../src/modules/files/application/request-upload.use-case';
import type { FileAssetSummary } from '../../src/modules/files/contracts';
import type { UploadDeclaration } from '../../src/modules/files/domain/file-policy';
import type { FileAssetRepository } from '../../src/modules/files/domain/ports';
import { InMemoryFileAssetRepository } from '../../src/modules/files/infrastructure/in-memory-file-asset-repository';
import {
  LocalStorageProvider,
  type WriteOutcome,
} from '../../src/modules/files/infrastructure/local-storage-provider';
import { PolicyAuthorizationService } from '../../src/modules/identity/application/authorization.service';
import { PROVISIONAL_POLICY_RULES } from '../../src/modules/identity/domain/provisional-policy';
import { AdjustableClock, expectOk } from './identity-harness';

export const TEST_STORAGE_SECRET = 'test-only-storage-signing-secret-of-32-bytes';

/** Bytes that carry each type's real signature, padded to a chosen size. */
export function sampleBytes(contentType: string, size = 64): Buffer {
  const heads: Record<string, number[]> = {
    'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
    'image/webp': [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')],
    'application/pdf': [...Buffer.from('%PDF-1.7')],
    'audio/mp4': [0, 0, 0, 0x20, ...Buffer.from('ftypM4A ')],
    'audio/aac': [0xff, 0xf1, 0x50, 0x80],
    'audio/ogg': [...Buffer.from('OggS')],
    'audio/webm': [0x1a, 0x45, 0xdf, 0xa3],
    'audio/mpeg': [...Buffer.from('ID3'), 4, 0],
  };
  const head = heads[contentType];
  if (head === undefined) throw new Error(`no sample for ${contentType}`);
  const bytes = Buffer.alloc(Math.max(size, head.length));
  Buffer.from(head).copy(bytes);
  return bytes;
}

/**
 * The files application layer over the REAL local storage adapter, in a
 * temporary directory: uploads go through actual signed URLs, streamed
 * writes and signature checks — only the metadata store is in memory.
 */
export async function filesHarness(
  options: { clock?: AdjustableClock; assets?: FileAssetRepository } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'files-test-'));
  const clock = options.clock ?? new AdjustableClock();
  const ids = new UuidIdGenerator();
  const assets = options.assets ?? new InMemoryFileAssetRepository();
  const storage = new LocalStorageProvider(root, TEST_STORAGE_SECRET, clock);
  const limiter = new InMemoryRateLimiter(clock);
  const authorization = new PolicyAuthorizationService(PROVISIONAL_POLICY_RULES);

  const h = {
    root,
    clock,
    assets,
    storage,
    limiter,
    authorization,
    requestUpload: new RequestUploadUseCase(authorization, assets, storage, limiter, clock, ids),
    completeUpload: new CompleteUploadUseCase(authorization, assets, storage, clock),
    fileAssets: new FileAssetsService(assets, storage, clock),

    /** PUTs bytes to an upload URL through the adapter's own verification. */
    async put(url: string, bytes: Buffer): Promise<WriteOutcome | 'link_invalid'> {
      const { token, query } = splitUrl(url);
      const grant = storage.verifyUpload(token, query);
      if (grant === null) return 'link_invalid';
      return storage.writeOnce(grant.storageKey, Readable.from([bytes]), grant.maxBytes);
    },

    /** Declare → PUT → complete, as a client would. Returns the attachable asset. */
    async upload(
      principal: Principal,
      declaration: Partial<UploadDeclaration> & Pick<UploadDeclaration, 'kind' | 'contentType'>,
      bytes?: Buffer,
    ): Promise<FileAssetSummary> {
      const body = bytes ?? sampleBytes(declaration.contentType);
      const ticket = expectOk(
        await h.requestUpload.execute({
          principal,
          declaration: { fileName: 'file', byteSize: body.length, ...declaration },
        }),
      );
      const outcome = await h.put(ticket.upload.url, body);
      if (outcome !== 'written') throw new Error(`upload failed: ${outcome}`);
      return expectOk(await h.completeUpload.execute({ principal, assetId: ticket.asset.id }));
    },

    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
  return h;
}

export type FilesHarness = Awaited<ReturnType<typeof filesHarness>>;

/** `/files/local/<token>?a=b` → the token and a query object, as Express would give them. */
export function splitUrl(url: string): { token: string; query: Record<string, string> } {
  const parsed = new URL(url, 'http://api.test');
  const token = parsed.pathname.split('/').pop() ?? '';
  return { token, query: Object.fromEntries(parsed.searchParams.entries()) };
}

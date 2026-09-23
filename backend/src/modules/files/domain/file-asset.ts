import { err, failure, ok, type Id, type Result } from '../../../shared';
import type { FileKind } from '../contracts/file-kind';
import type { ValidatedUpload } from './file-policy';

export type FileAssetId = Id<'FileAsset'>;

/**
 *   PENDING    an upload URL was issued; nothing verified yet
 *   AVAILABLE  the bytes arrived, match the declared size and type, and may be used
 *   REJECTED   the bytes did not match what was declared; they were deleted
 */
export type FileAssetStatus = 'PENDING' | 'AVAILABLE' | 'REJECTED';

/**
 * A stored file's metadata. The bytes live in the storage provider; Postgres
 * holds this row and the key that points at them. Large binaries in the
 * database would wreck backup and replication long before query performance.
 */
export interface FileAsset {
  readonly id: FileAssetId;
  /** The uploader — the only account that may attach it. */
  readonly ownerUserId: string;
  readonly kind: FileKind;
  readonly contentType: string;
  /** Declared before upload; the stored object must match it exactly. */
  readonly byteSize: number;
  /** Opaque, generated from ids. Never derived from anything the client sent. */
  readonly storageKey: string;
  readonly displayName: string;
  readonly status: FileAssetStatus;
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export function pendingAsset(input: {
  readonly id: FileAssetId;
  readonly ownerUserId: string;
  readonly storageKey: string;
  readonly upload: ValidatedUpload;
  readonly at: Date;
}): FileAsset {
  return {
    id: input.id,
    ownerUserId: input.ownerUserId,
    kind: input.upload.kind,
    contentType: input.upload.contentType,
    byteSize: input.upload.byteSize,
    storageKey: input.storageKey,
    displayName: input.upload.displayName,
    status: 'PENDING',
    durationMs: input.upload.durationMs,
    width: input.upload.width,
    height: input.upload.height,
    createdAt: input.at,
    completedAt: null,
  };
}

export function markAvailable(asset: FileAsset, at: Date): Result<FileAsset> {
  if (asset.status !== 'PENDING') {
    return err(
      failure('conflict', 'files.upload_already_completed', 'This upload was already completed.'),
    );
  }
  return ok({ ...asset, status: 'AVAILABLE', completedAt: at });
}

export function markRejected(asset: FileAsset, at: Date): FileAsset {
  return { ...asset, status: 'REJECTED', completedAt: at };
}

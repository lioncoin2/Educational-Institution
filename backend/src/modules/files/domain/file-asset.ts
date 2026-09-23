import type { Id } from '../../../shared';

export type FileAssetId = Id<'FileAsset'>;

import type { FileKind } from '../contracts/file-kind';

export type { FileKind };

/**
 * Metadata only.
 *
 * The bytes live in object storage; Postgres holds this row and the storage key
 * that points at them. Large binaries in the database would wreck backup and
 * replication long before they wrecked query performance.
 */
export type FileAssetStatus = 'pending' | 'ready' | 'rejected';

export interface FileAsset {
  readonly id: FileAssetId;
  readonly ownerUserId: string;
  readonly kind: FileKind;
  readonly contentType: string;
  readonly byteSize: number;
  /** Opaque key in the storage provider. Never a client-supplied path. */
  readonly storageKey: string;
  /** Original name, for display only — never used to build a path. */
  readonly originalName: string;
  readonly status: FileAssetStatus;
  readonly createdAt: Date;
}

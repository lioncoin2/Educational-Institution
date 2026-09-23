import type { FileAsset, FileAssetId } from './file-asset';

export interface FileAssetRepository {
  create(asset: FileAsset): Promise<void>;
  findById(id: FileAssetId): Promise<FileAsset | null>;
  findManyByIds(ids: readonly FileAssetId[]): Promise<readonly FileAsset[]>;
  /**
   * Compare-and-set from PENDING: completes an upload exactly once, even if
   * the client calls "complete" twice at the same moment.
   */
  transition(next: FileAsset, expectedStatus: 'PENDING'): Promise<boolean>;
}

export const FILE_ASSET_REPOSITORY = Symbol('FILE_ASSET_REPOSITORY');

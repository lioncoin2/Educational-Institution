import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, err, failure, ok, type Clock, type Result } from '../../../shared';
import type { DownloadLink, FileAssets, FileAssetSummary } from '../contracts/file-assets';
import type { FileKind } from '../contracts/file-kind';
import type { FileAssetId } from '../domain/file-asset';
import { dispositionFor } from '../domain/file-policy';
import { FILE_ASSET_REPOSITORY, type FileAssetRepository } from '../domain/ports';
import { STORAGE_PROVIDER, type StorageProvider } from '../domain/storage-provider';
import { DOWNLOAD_URL_TTL_SECONDS } from './files-policy';
import { toSummary } from './views';

const NOT_FOUND = failure('not_found', 'files.asset_not_found', 'No such file.');

/** The files module's public face — see the contract for the division of labour. */
@Injectable()
export class FileAssetsService implements FileAssets {
  constructor(
    @Inject(FILE_ASSET_REPOSITORY) private readonly assets: FileAssetRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async describe(assetIds: readonly string[]): Promise<readonly FileAssetSummary[]> {
    if (assetIds.length === 0) return [];
    const found = await this.assets.findManyByIds([...new Set(assetIds)] as FileAssetId[]);
    return found.filter((asset) => asset.status === 'AVAILABLE').map(toSummary);
  }

  async verifyAttachable(
    assetId: string,
    ownerUserId: string,
    acceptedKinds: readonly FileKind[],
  ): Promise<Result<FileAssetSummary>> {
    const asset = await this.assets.findById(assetId as FileAssetId);
    if (asset === null || asset.ownerUserId !== ownerUserId) return err(NOT_FOUND);
    if (asset.status !== 'AVAILABLE') {
      return err(
        failure(
          'precondition_failed',
          'files.asset_not_ready',
          'This file has not finished uploading.',
        ),
      );
    }
    if (!acceptedKinds.includes(asset.kind)) {
      return err(
        failure(
          'validation',
          'files.asset_kind_not_accepted',
          `A ${asset.kind} file cannot be used here.`,
          {
            accepted: acceptedKinds,
          },
        ),
      );
    }
    return ok(toSummary(asset));
  }

  async createDownloadLink(assetId: string): Promise<Result<DownloadLink>> {
    const asset = await this.assets.findById(assetId as FileAssetId);
    if (asset === null || asset.status !== 'AVAILABLE') return err(NOT_FOUND);

    const expiresAt = new Date(this.clock.now().getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000);
    const url = await this.storage.createDownloadUrl({
      storageKey: asset.storageKey,
      contentType: asset.contentType,
      fileName: asset.displayName,
      disposition: dispositionFor(asset.kind),
      expiresAt,
    });
    return ok({ url, expiresAt });
  }
}

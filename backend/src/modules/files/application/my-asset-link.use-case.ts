import { Inject, Injectable } from '@nestjs/common';

import { err, failure, type Principal, type Result } from '../../../shared';
import { FILE_ASSETS, type DownloadLink, type FileAssets } from '../contracts/file-assets';
import type { FileAssetId } from '../domain/file-asset';
import { FILE_ASSET_REPOSITORY, type FileAssetRepository } from '../domain/ports';

const NOT_FOUND = failure('not_found', 'files.asset_not_found', 'No such file.');

/**
 * A short-lived link to an asset the caller uploaded.
 *
 * This is the one read path Files authorizes itself: the owner may always
 * fetch their own object. It is how a client renders its own profile picture
 * (whose reference it already holds from `/auth/me`). Reading anyone else's
 * file still belongs to the module that attached it — Files does not know who
 * else may see it. An asset the caller does not own reads as "no such file".
 */
@Injectable()
export class GetMyAssetLinkUseCase {
  constructor(
    @Inject(FILE_ASSET_REPOSITORY) private readonly assets: FileAssetRepository,
    @Inject(FILE_ASSETS) private readonly files: FileAssets,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly assetId: string;
  }): Promise<Result<DownloadLink>> {
    const asset = await this.assets.findById(command.assetId as FileAssetId);
    if (asset === null || asset.ownerUserId !== command.principal.userId) return err(NOT_FOUND);
    return this.files.createDownloadLink(command.assetId);
  }
}

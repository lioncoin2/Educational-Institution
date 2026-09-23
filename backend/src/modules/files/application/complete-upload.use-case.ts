import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, err, failure, ok, type Clock, type Principal, type Result } from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import { Permissions } from '../../identity/contracts/permissions';
import type { FileAssetSummary } from '../contracts/file-assets';
import { matchesContentType, SIGNATURE_HEAD_BYTES } from '../domain/content-signature';
import { markAvailable, markRejected, type FileAssetId } from '../domain/file-asset';
import { FILE_ASSET_REPOSITORY, type FileAssetRepository } from '../domain/ports';
import { STORAGE_PROVIDER, type StorageProvider } from '../domain/storage-provider';
import { toSummary } from './views';

const NOT_FOUND = failure('not_found', 'files.asset_not_found', 'No such upload.');

/**
 * Step two: "I have uploaded it." The claim is checked, not believed:
 *
 *   1. the object exists in storage;
 *   2. its size is exactly the declared size;
 *   3. its first bytes carry the declared type's signature.
 *
 * Pass, and the asset becomes AVAILABLE — attachable. Fail, and it becomes
 * REJECTED and the bytes are deleted. Only the uploader may complete.
 */
@Injectable()
export class CompleteUploadUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(FILE_ASSET_REPOSITORY) private readonly assets: FileAssetRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly assetId: string;
  }): Promise<Result<FileAssetSummary>> {
    const allowed = this.authorization.authorize(command.principal, Permissions.files.upload);
    if (!allowed.ok) return allowed;

    const asset = await this.assets.findById(command.assetId as FileAssetId);
    // Someone else's upload is reported exactly like a missing one.
    if (asset === null || asset.ownerUserId !== command.principal.userId) return err(NOT_FOUND);
    if (asset.status === 'AVAILABLE') return ok(toSummary(asset)); // idempotent retry
    if (asset.status === 'REJECTED') {
      return err(
        failure('conflict', 'files.upload_rejected', 'This upload was rejected. Start a new one.'),
      );
    }

    const stored = await this.storage.stat(asset.storageKey);
    if (stored === null) {
      return err(
        failure(
          'precondition_failed',
          'files.upload_missing',
          'The file has not been uploaded yet.',
        ),
      );
    }

    const now = this.clock.now();
    const head = await this.storage.readHead(asset.storageKey, SIGNATURE_HEAD_BYTES);
    const sizeMatches = stored.byteSize === asset.byteSize;
    if (!sizeMatches || !matchesContentType(asset.contentType, head)) {
      await this.assets.transition(markRejected(asset, now), 'PENDING');
      await this.storage.delete(asset.storageKey);
      return err(
        failure(
          'validation',
          'files.content_mismatch',
          sizeMatches
            ? `The file is not a valid ${asset.contentType} file.`
            : 'The uploaded size does not match the declared size.',
        ),
      );
    }

    const available = markAvailable(asset, now);
    if (!available.ok) return available;
    if (!(await this.assets.transition(available.value, 'PENDING'))) {
      // A concurrent completion won; report the stored state.
      const current = await this.assets.findById(asset.id);
      return current?.status === 'AVAILABLE' ? ok(toSummary(current)) : err(NOT_FOUND);
    }
    return ok(toSummary(available.value));
  }
}

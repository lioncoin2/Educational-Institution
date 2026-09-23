import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  RATE_LIMITER,
  err,
  failure,
  ok,
  type Clock,
  type IdGenerator,
  type Principal,
  type RateLimiter,
  type Result,
} from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import { Permissions } from '../../identity/contracts/permissions';
import { pendingAsset } from '../domain/file-asset';
import {
  buildStorageKey,
  FILE_POLICY,
  validateUpload,
  type UploadDeclaration,
} from '../domain/file-policy';
import { FILE_ASSET_REPOSITORY, type FileAssetRepository } from '../domain/ports';
import { STORAGE_PROVIDER, type StorageProvider } from '../domain/storage-provider';
import { UPLOAD_REQUESTS_PER_USER, UPLOAD_URL_TTL_SECONDS } from './files-policy';
import { toSummary, type UploadTicket } from './views';

/**
 * Step one of an upload: declare it, and receive a URL to put the bytes to.
 *
 * Everything is validated before any URL exists — kind, content type,
 * extension, size, metadata — and the URL itself is bound to that exact key,
 * type and size ceiling. The bytes then go straight to storage; the API never
 * holds them in memory.
 */
@Injectable()
export class RequestUploadUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(FILE_ASSET_REPOSITORY) private readonly assets: FileAssetRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly declaration: UploadDeclaration;
  }): Promise<Result<UploadTicket>> {
    const allowed = this.authorization.authorize(command.principal, Permissions.files.upload);
    if (!allowed.ok) return allowed;

    const throttle = await this.limiter.consume(command.principal.userId, UPLOAD_REQUESTS_PER_USER);
    if (!throttle.allowed) {
      return err(
        failure('rate_limited', 'files.too_many_uploads', 'Too many uploads. Try again later.', {
          retryAfterSeconds: throttle.retryAfterSeconds,
        }),
      );
    }

    const upload = validateUpload(command.declaration);
    if (!upload.ok) return upload;

    const now = this.clock.now();
    const id = this.ids.next<'FileAsset'>();
    const asset = pendingAsset({
      id,
      ownerUserId: command.principal.userId,
      storageKey: buildStorageKey(upload.value.kind, id, now),
      upload: upload.value,
      at: now,
    });
    await this.assets.create(asset);

    const target = await this.storage.createUploadTarget({
      storageKey: asset.storageKey,
      contentType: asset.contentType,
      // The declared size, not the kind's ceiling: the object must be exactly
      // what was declared, and completion checks it byte for byte.
      maxBytes: Math.min(asset.byteSize, FILE_POLICY[asset.kind].maxBytes),
      expiresAt: new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000),
    });

    return ok({ asset: { ...toSummary(asset), status: asset.status }, upload: target });
  }
}

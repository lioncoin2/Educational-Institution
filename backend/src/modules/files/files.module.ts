import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { DATABASE, type Database } from '../../platform/database';
import { CLOCK, type Clock } from '../../shared';
import { IdentityModule } from '../identity/identity.module';
import { UploadsController } from './api/uploads.controller';
import { CompleteUploadUseCase } from './application/complete-upload.use-case';
import { FileAssetsService } from './application/file-assets.service';
import { RequestUploadUseCase } from './application/request-upload.use-case';
import { FILE_ASSETS } from './contracts/file-assets';
import { FILE_ASSET_REPOSITORY, type FileAssetRepository } from './domain/ports';
import { STORAGE_PROVIDER } from './domain/storage-provider';
import { DrizzleFileAssetRepository } from './infrastructure/drizzle-file-asset-repository';
import { InMemoryFileAssetRepository } from './infrastructure/in-memory-file-asset-repository';
import { LocalStorageProvider } from './infrastructure/local-storage-provider';
import { LocalTransferController } from './infrastructure/local-transfer.controller';

/**
 * Files — what may be stored, verified storage of it, and short-lived links.
 *
 * It exports ONE thing: `FILE_ASSETS`, the asset-level contract. The storage
 * port stays inside: a module holding it could mint a link to any object,
 * whoever uploaded it. Modules that attach files authorize their readers and
 * then ask `FILE_ASSETS` for a link.
 *
 * The storage adapter is chosen here, once. An S3-compatible adapter replaces
 * `LocalStorageProvider` and drops `LocalTransferController` — the object
 * store serves its own signed URLs — and nothing outside this file changes.
 */
@Module({
  imports: [IdentityModule],
  controllers: [UploadsController, LocalTransferController],
  providers: [
    {
      provide: LocalStorageProvider,
      inject: [APP_CONFIG, CLOCK],
      useFactory: (config: AppConfig, clock: Clock) =>
        new LocalStorageProvider(config.storage.localRoot, config.storage.signingSecret, clock),
    },
    { provide: STORAGE_PROVIDER, useExisting: LocalStorageProvider },
    {
      // Postgres when a database is configured; memory otherwise.
      provide: FILE_ASSET_REPOSITORY,
      inject: [APP_CONFIG, DATABASE],
      useFactory: (config: AppConfig, db: Database): FileAssetRepository =>
        config.database.configured
          ? new DrizzleFileAssetRepository(db)
          : new InMemoryFileAssetRepository(),
    },
    RequestUploadUseCase,
    CompleteUploadUseCase,
    { provide: FILE_ASSETS, useClass: FileAssetsService },
  ],
  exports: [FILE_ASSETS],
})
export class FilesModule {}

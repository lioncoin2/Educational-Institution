import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { STORAGE_PROVIDER } from './contracts';
import { LocalStorageProvider } from './infrastructure/local-storage-provider';

/**
 * Files — durable metadata plus signed access to bytes held outside the database.
 *
 * The provider is selected once, here. Swapping `LocalStorageProvider` for an
 * S3-compatible adapter is a change to this file only, because every caller
 * depends on the `STORAGE_PROVIDER` port.
 */
@Module({
  providers: [
    {
      provide: STORAGE_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new LocalStorageProvider(config.storage.localRoot, config.auth.jwtSecret),
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class FilesModule {}

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { FileAsset, FileAssetId } from '../domain/file-asset';
import type { FileAssetRepository } from '../domain/ports';
import { fileAssets } from './schema';

type FileAssetRow = typeof fileAssets.$inferSelect;

/** File metadata in Postgres. Completion is one conditional UPDATE — exactly once. */
@Injectable()
export class DrizzleFileAssetRepository implements FileAssetRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(asset: FileAsset): Promise<void> {
    await this.db.insert(fileAssets).values({
      id: asset.id,
      ownerUserId: asset.ownerUserId,
      kind: asset.kind,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      storageKey: asset.storageKey,
      displayName: asset.displayName,
      status: asset.status,
      durationMs: asset.durationMs,
      width: asset.width,
      height: asset.height,
      createdAt: asset.createdAt,
      completedAt: asset.completedAt,
    });
  }

  async findById(id: FileAssetId): Promise<FileAsset | null> {
    const rows = await this.db.select().from(fileAssets).where(eq(fileAssets.id, id)).limit(1);
    const row = rows[0];
    return row === undefined ? null : toAsset(row);
  }

  async findManyByIds(ids: readonly FileAssetId[]): Promise<readonly FileAsset[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(fileAssets)
      .where(inArray(fileAssets.id, [...ids]));
    return rows.map(toAsset);
  }

  async transition(next: FileAsset, expectedStatus: 'PENDING'): Promise<boolean> {
    const updated = await this.db
      .update(fileAssets)
      .set({ status: next.status, completedAt: next.completedAt })
      .where(and(eq(fileAssets.id, next.id), eq(fileAssets.status, expectedStatus)))
      .returning({ id: fileAssets.id });
    return updated.length === 1;
  }
}

function toAsset(row: FileAssetRow): FileAsset {
  return {
    id: row.id as FileAssetId,
    ownerUserId: row.ownerUserId,
    kind: row.kind,
    contentType: row.contentType,
    byteSize: row.byteSize,
    storageKey: row.storageKey,
    displayName: row.displayName,
    status: row.status,
    durationMs: row.durationMs,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

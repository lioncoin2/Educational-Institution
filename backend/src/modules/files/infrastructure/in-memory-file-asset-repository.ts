import type { FileAsset, FileAssetId } from '../domain/file-asset';
import type { FileAssetRepository } from '../domain/ports';

/**
 * File metadata in memory — unit tests, and a server run without a database.
 * Enforces what the table does: unique ids and storage keys, and
 * compare-and-set completion.
 */
export class InMemoryFileAssetRepository implements FileAssetRepository {
  private readonly byId = new Map<string, FileAsset>();

  async create(asset: FileAsset): Promise<void> {
    for (const existing of this.byId.values()) {
      if (existing.id === asset.id || existing.storageKey === asset.storageKey) {
        throw new Error('duplicate file asset');
      }
    }
    this.byId.set(asset.id, asset);
  }

  async findById(id: FileAssetId): Promise<FileAsset | null> {
    return this.byId.get(id) ?? null;
  }

  async findManyByIds(ids: readonly FileAssetId[]): Promise<readonly FileAsset[]> {
    return [...new Set(ids)].flatMap((id) => {
      const asset = this.byId.get(id);
      return asset === undefined ? [] : [asset];
    });
  }

  async transition(next: FileAsset, expectedStatus: 'PENDING'): Promise<boolean> {
    const current = this.byId.get(next.id);
    if (current === undefined || current.status !== expectedStatus) return false;
    this.byId.set(next.id, next);
    return true;
  }
}

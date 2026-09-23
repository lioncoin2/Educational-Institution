import type { FileAssetSummary } from '../contracts/file-assets';
import type { FileAsset } from '../domain/file-asset';

export function toSummary(asset: FileAsset): FileAssetSummary {
  return {
    id: asset.id,
    kind: asset.kind,
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    displayName: asset.displayName,
    durationMs: asset.durationMs,
    width: asset.width,
    height: asset.height,
  };
}

export interface UploadTicket {
  readonly asset: FileAssetSummary & { readonly status: FileAsset['status'] };
  readonly upload: {
    readonly url: string;
    readonly method: 'PUT';
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
  };
}

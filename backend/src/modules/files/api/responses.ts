import type { FileAssetSummary } from '../contracts/file-assets';
import type { FileKind } from '../contracts/file-kind';
import type { UploadTicket } from '../application/views';

export interface FileAssetResponse {
  readonly id: string;
  readonly kind: FileKind;
  readonly contentType: string;
  readonly byteSize: number;
  readonly displayName: string;
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface UploadTicketResponse {
  readonly asset: FileAssetResponse & { readonly status: string };
  /**
   * Where to PUT the bytes. `url` is absolute for an object store and
   * path-relative to the API for local storage. Send `headers` exactly.
   */
  readonly upload: {
    readonly url: string;
    readonly method: 'PUT';
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  };
}

export function toFileAssetResponse(asset: FileAssetSummary): FileAssetResponse {
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

export function toUploadTicketResponse(ticket: UploadTicket): UploadTicketResponse {
  return {
    asset: { ...toFileAssetResponse(ticket.asset), status: ticket.asset.status },
    upload: {
      url: ticket.upload.url,
      method: ticket.upload.method,
      headers: ticket.upload.headers,
      expiresAt: ticket.upload.expiresAt.toISOString(),
    },
  };
}

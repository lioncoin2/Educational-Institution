/**
 * The storage port.
 *
 * Bytes never pass through the API process: clients upload to, and download
 * from, the storage provider directly using short-lived signed URLs we mint.
 * That keeps the application stateless and makes large media a storage problem
 * rather than a bandwidth problem.
 *
 * Implementations: `LocalStorageProvider` today; an S3-compatible adapter next.
 */
export interface PresignedUpload {
  readonly url: string;
  readonly method: 'PUT' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly storageKey: string;
  readonly expiresInSeconds: number;
}

export interface UploadRequest {
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly expiresInSeconds: number;
}

export interface StorageProvider {
  /** Mints a URL the client may upload to, scoped to one key and content type. */
  createUploadUrl(request: UploadRequest): Promise<PresignedUpload>;

  /** Mints a short-lived read URL. Never a permanent public link. */
  createDownloadUrl(storageKey: string, expiresInSeconds: number): Promise<string>;

  exists(storageKey: string): Promise<boolean>;

  delete(storageKey: string): Promise<void>;
}

export { STORAGE_PROVIDER } from '../contracts';

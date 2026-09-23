/**
 * The storage port — INTERNAL to the files module.
 *
 * It is deliberately not in `contracts/`. A module holding it could mint a
 * link to any object in the store, whoever uploaded it and whatever it means;
 * other modules get the asset-level `FileAssets` contract instead. (The
 * Foundation exported this port publicly. That was the defect.)
 *
 * The shape is presigned-URL-first so an object store can serve uploads and
 * downloads directly. Every expiry is an absolute instant computed by the
 * caller from the injected clock, so adapters hold no clock of their own.
 */
export interface UploadSpec {
  readonly storageKey: string;
  readonly contentType: string;
  /** Hard ceiling. The upload is cut off, not trusted, past this many bytes. */
  readonly maxBytes: number;
  readonly expiresAt: Date;
}

export interface UploadTarget {
  /** Absolute for an object store; path-relative to the API for local storage. */
  readonly url: string;
  readonly method: 'PUT';
  /** Headers the client MUST send, exactly — they are bound into the signature. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface DownloadSpec {
  readonly storageKey: string;
  readonly contentType: string;
  readonly fileName: string;
  readonly disposition: 'inline' | 'attachment';
  readonly expiresAt: Date;
}

export interface StoredObject {
  readonly byteSize: number;
}

export interface StorageProvider {
  /**
   * A URL that can PUT exactly one object at `storageKey`, of `contentType`,
   * no larger than `maxBytes`, until `expiresAt` — and do nothing else. A
   * download link must never be usable to write, nor an upload link to read.
   */
  createUploadTarget(spec: UploadSpec): Promise<UploadTarget>;
  /** A URL that can GET one object, with its response headers fixed by us. */
  createDownloadUrl(spec: DownloadSpec): Promise<string>;
  stat(storageKey: string): Promise<StoredObject | null>;
  /** The first `byteCount` bytes, for signature checks. */
  readHead(storageKey: string, byteCount: number): Promise<Uint8Array>;
  delete(storageKey: string): Promise<void>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

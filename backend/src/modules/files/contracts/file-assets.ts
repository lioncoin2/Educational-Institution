import type { Result } from '../../../shared';
import type { FileKind } from './file-kind';

/** DI token for the one service other modules use to work with stored files. */
export const FILE_ASSETS = Symbol('FILE_ASSETS');

/**
 * What another module may know about a stored file — enough to render it,
 * never where it lives. No storage key, no URL (URLs expire; a reference
 * does not).
 */
export interface FileAssetSummary {
  readonly id: string;
  readonly kind: FileKind;
  readonly contentType: string;
  readonly byteSize: number;
  /** Sanitized original name, with an extension that matches the content type. */
  readonly displayName: string;
  /** Voice and audio: client-reported, bounded. Null when unknown. */
  readonly durationMs: number | null;
  /** Images: client-reported, bounded. Null when unknown. */
  readonly width: number | null;
  readonly height: number | null;
}

export interface DownloadLink {
  readonly url: string;
  readonly expiresAt: Date;
}

/**
 * Stored files, at the level of meaning rather than bytes.
 *
 * Files decides what may be stored and hands out short-lived links. It does
 * NOT decide who may read a file: it cannot know what a file means — a voice
 * message, a homework submission, a certificate scan. The module that
 * attached the file authorizes the reader, then asks for a link.
 *
 * The raw storage port is deliberately not part of this contract: a module
 * holding it could mint a link to any key in the store, whoever uploaded it.
 */
export interface FileAssets {
  /** Summaries of AVAILABLE assets. Unknown or unavailable ids are absent. */
  describe(assetIds: readonly string[]): Promise<readonly FileAssetSummary[]>;

  /**
   * Whether `ownerUserId` may attach this asset: it exists, they uploaded it,
   * the upload was completed and verified, and it is one of `acceptedKinds`.
   * Someone else's asset is reported exactly like a missing one.
   */
  verifyAttachable(
    assetId: string,
    ownerUserId: string,
    acceptedKinds: readonly FileKind[],
  ): Promise<Result<FileAssetSummary>>;

  /**
   * A short-lived download link. THE CALLER MUST ALREADY HAVE AUTHORIZED the
   * reader against its own rules — this method does not, and cannot.
   */
  createDownloadLink(assetId: string): Promise<Result<DownloadLink>>;
}

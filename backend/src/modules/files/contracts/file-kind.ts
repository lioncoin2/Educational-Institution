/** What kind of thing a file is. Declared publicly: messaging and assignments
 *  both reference stored files and must be able to name their kind. */
export type FileKind = 'image' | 'document' | 'audio' | 'voice_message';

/** A durable reference other modules store instead of a URL (URLs expire). */
export interface FileAssetRef {
  readonly fileAssetId: string;
  readonly kind: FileKind;
  readonly contentType: string;
  readonly byteSize: number;
}

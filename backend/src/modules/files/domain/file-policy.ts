import type { FileKind } from './file-asset';

/**
 * Upload policy: what may be uploaded, and how large.
 *
 * Enforced server-side before a upload URL is ever issued. Client-side checks
 * are a convenience; this is the boundary that actually holds.
 */
export const ALLOWED_CONTENT_TYPES: Readonly<Record<FileKind, readonly string[]>> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  document: ['application/pdf'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/aac'],
  voice_message: ['audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac'],
};

/** Per-kind ceilings, in bytes. */
export const MAX_BYTES: Readonly<Record<FileKind, number>> = {
  image: 10 * 1024 * 1024,
  document: 25 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
  voice_message: 5 * 1024 * 1024,
};

export type PolicyViolation =
  | { readonly reason: 'content_type_not_allowed'; readonly contentType: string }
  | { readonly reason: 'too_large'; readonly byteSize: number; readonly maxBytes: number }
  | { readonly reason: 'empty_file' };

export function validateUpload(
  kind: FileKind,
  contentType: string,
  byteSize: number,
): PolicyViolation | null {
  if (byteSize <= 0) return { reason: 'empty_file' };

  if (!ALLOWED_CONTENT_TYPES[kind].includes(contentType)) {
    return { reason: 'content_type_not_allowed', contentType };
  }

  const maxBytes = MAX_BYTES[kind];
  if (byteSize > maxBytes) return { reason: 'too_large', byteSize, maxBytes };

  return null;
}

/**
 * Builds the storage key.
 *
 * The client's filename never reaches the filesystem: the key is derived from
 * ids we generate, and the original name is kept only as metadata. That closes
 * path traversal (`../../etc/passwd`), collisions and encoding tricks in one go.
 */
export function buildStorageKey(kind: FileKind, assetId: string, at: Date): string {
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${kind}/${yyyy}/${mm}/${assetId}`;
}

/** Display-safe original name: no control characters, no separators, bounded. */
export function sanitizeOriginalName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .trim();
  return (cleaned.length === 0 ? 'file' : cleaned).slice(0, 200);
}

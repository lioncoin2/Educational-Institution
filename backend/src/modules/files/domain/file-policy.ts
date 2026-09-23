import { err, failure, ok, type Result } from '../../../shared';
import type { FileKind } from '../contracts/file-kind';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  UPLOAD POLICY — ALLOW-LIST; LIMITS ARE PROVISIONAL (open-questions.md Q19)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every upload is untrusted. What may be stored is an allow-list per kind:
 * a content type, the file extensions that may accompany it, and a size cap.
 * Anything not listed is refused — there is no "other" and no executable
 * type. The magic bytes of the stored object are checked against the declared
 * type before it can be used (see content-signature.ts).
 *
 * The size and duration limits are provisional engineering defaults, not an
 * institutional decision.
 */
interface KindPolicy {
  /** content type → the extensions that may accompany it (first is canonical). */
  readonly contentTypes: Readonly<Record<string, readonly string[]>>;
  readonly maxBytes: number;
}

const MB = 1024 * 1024;

export const FILE_POLICY: Readonly<Record<FileKind, KindPolicy>> = {
  IMAGE: {
    contentTypes: {
      'image/jpeg': ['jpg', 'jpeg'],
      'image/png': ['png'],
      'image/webp': ['webp'],
    },
    maxBytes: 10 * MB,
  },
  // What recorders actually produce: AAC in MP4 (iOS, Android, Safari),
  // Opus in WebM (Chrome) or Ogg (Firefox), raw ADTS AAC.
  VOICE: {
    contentTypes: {
      'audio/mp4': ['m4a', 'mp4'],
      'audio/aac': ['aac'],
      'audio/ogg': ['ogg', 'oga', 'opus'],
      'audio/webm': ['webm'],
    },
    maxBytes: 5 * MB, // ≈ 10 minutes of AAC at 64 kbit/s
  },
  AUDIO: {
    contentTypes: {
      'audio/mpeg': ['mp3'],
      'audio/mp4': ['m4a', 'mp4'],
      'audio/aac': ['aac'],
      'audio/ogg': ['ogg', 'oga', 'opus'],
    },
    maxBytes: 50 * MB,
  },
  // PDF only. Office formats are ZIP containers that can carry macros; whether
  // to accept them is Q19.
  DOCUMENT: {
    contentTypes: { 'application/pdf': ['pdf'] },
    maxBytes: 25 * MB,
  },
};

/** Voice messages are short by nature; the cap bounds client-reported metadata. */
export const MAX_VOICE_DURATION_MS = 10 * 60 * 1000;
export const MAX_AUDIO_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_IMAGE_DIMENSION = 20_000;
export const DISPLAY_NAME_MAX_LENGTH = 200;

export interface UploadDeclaration {
  readonly kind: FileKind;
  readonly contentType: string;
  readonly byteSize: number;
  readonly fileName: string;
  readonly durationMs?: number | null;
  readonly width?: number | null;
  readonly height?: number | null;
}

export interface ValidatedUpload {
  readonly kind: FileKind;
  readonly contentType: string;
  readonly byteSize: number;
  readonly displayName: string;
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

const invalid = (code: string, message: string, details?: Record<string, unknown>) =>
  err(failure('validation', `files.${code}`, message, details));

/** `Image/JPEG; charset=x` → `image/jpeg`. Parameters are never meaningful here. */
export function normalizeContentType(raw: string): string {
  return (raw.split(';')[0] ?? '').trim().toLowerCase();
}

export function validateUpload(declaration: UploadDeclaration): Result<ValidatedUpload> {
  const policy = FILE_POLICY[declaration.kind];
  const contentType = normalizeContentType(declaration.contentType);
  const extensions = policy.contentTypes[contentType];
  if (extensions === undefined) {
    return invalid(
      'content_type_not_allowed',
      `${contentType || 'That type'} is not accepted here.`,
      {
        kind: declaration.kind,
        accepted: Object.keys(policy.contentTypes),
      },
    );
  }

  if (!Number.isInteger(declaration.byteSize) || declaration.byteSize <= 0) {
    return invalid('empty', 'The file is empty.');
  }
  if (declaration.byteSize > policy.maxBytes) {
    return invalid('too_large', 'The file is too large.', { maxBytes: policy.maxBytes });
  }

  const cleaned = sanitizeDisplayName(declaration.fileName);
  const extension = extensionOf(cleaned);
  if (extension !== null && !extensions.includes(extension)) {
    // "photo.html" declared as image/png: refuse, rather than store a name
    // that a browser or an OS would later interpret by its extension.
    return invalid('extension_mismatch', `A .${extension} file cannot be ${contentType}.`, {
      accepted: extensions,
    });
  }
  const displayName = extension === null ? `${cleaned}.${extensions[0] ?? 'bin'}` : cleaned;

  const metadata = validateMetadata(declaration);
  if (!metadata.ok) return metadata;

  return ok({
    kind: declaration.kind,
    contentType,
    byteSize: declaration.byteSize,
    displayName,
    ...metadata.value,
  });
}

function validateMetadata(
  declaration: UploadDeclaration,
): Result<Pick<ValidatedUpload, 'durationMs' | 'width' | 'height'>> {
  const { kind } = declaration;
  const durationMs = declaration.durationMs ?? null;
  const width = declaration.width ?? null;
  const height = declaration.height ?? null;

  if (durationMs !== null) {
    const max =
      kind === 'VOICE' ? MAX_VOICE_DURATION_MS : kind === 'AUDIO' ? MAX_AUDIO_DURATION_MS : 0;
    if (max === 0 || !Number.isInteger(durationMs) || durationMs <= 0 || durationMs > max) {
      return invalid('metadata_invalid', 'The duration is not valid for this file.');
    }
  }
  if (width !== null || height !== null) {
    const valid = (n: number | null) =>
      n !== null && Number.isInteger(n) && n > 0 && n <= MAX_IMAGE_DIMENSION;
    if (kind !== 'IMAGE' || !valid(width) || !valid(height)) {
      return invalid('metadata_invalid', 'The dimensions are not valid for this file.');
    }
  }
  return ok({ durationMs, width, height });
}

/**
 * A display-safe name. Never used to build a path — storage keys come from
 * ids only — but it is shown to people and offered as a download name, so:
 *
 *   - control characters removed;
 *   - Unicode BIDI controls removed. "invoice<U+202E>fdp.exe" renders as
 *     "invoiceexe.pdf" in a right-to-left-aware UI — which this app is;
 *   - path separators replaced, leading dots removed (no hidden files);
 *   - length capped.
 */
export function sanitizeDisplayName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  const bounded = [...cleaned].slice(0, DISPLAY_NAME_MAX_LENGTH).join('');
  return bounded.length === 0 ? 'file' : bounded;
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * The storage key: derived from ids only, never from anything the client sent.
 * No extension either — nothing that reads the store can be tricked into
 * interpreting an object by its name.
 */
export function buildStorageKey(kind: FileKind, assetId: string, at: Date): string {
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${kind.toLowerCase()}/${yyyy}/${mm}/${assetId}`;
}

/** Images and audio play in place; documents always download. */
export function dispositionFor(kind: FileKind): 'inline' | 'attachment' {
  return kind === 'DOCUMENT' ? 'attachment' : 'inline';
}

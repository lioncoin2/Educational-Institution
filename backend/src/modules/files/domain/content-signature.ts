/**
 * Does a stored object actually start the way its declared type says?
 *
 * The client declares a content type when it asks to upload; nothing stops it
 * lying. Before an upload may be used, its first bytes are checked against the
 * format's signature ("magic bytes"). A PNG that begins like an HTML page, or a
 * "PDF" that is really an executable, is rejected.
 *
 * This proves the container format, not that the file is harmless — a valid
 * PDF can still be hostile, which is why documents are always served as
 * downloads, never rendered in place (see dispositionFor).
 */
export const SIGNATURE_HEAD_BYTES = 16;

type Matcher = (head: Uint8Array) => boolean;

const startsWith =
  (...bytes: number[]): Matcher =>
  (head) =>
    bytes.every((byte, index) => head[index] === byte);

const ascii = (text: string, offset = 0): Matcher => {
  const bytes = [...text].map((c) => c.charCodeAt(0));
  return (head) => bytes.every((byte, index) => head[offset + index] === byte);
};

const all =
  (...matchers: Matcher[]): Matcher =>
  (head) =>
    matchers.every((match) => match(head));

const any =
  (...matchers: Matcher[]): Matcher =>
  (head) =>
    matchers.some((match) => match(head));

/** ISO base media (MP4/M4A): a box size, then "ftyp". */
const isoMedia = ascii('ftyp', 4);

/** MPEG audio frame sync: 11 set bits. */
const mpegFrame: Matcher = (head) => head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0;

/** ADTS AAC: 12-bit sync, layer bits zero. */
const adts: Matcher = (head) => head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0;

const SIGNATURES: Readonly<Record<string, Matcher>> = {
  'image/jpeg': startsWith(0xff, 0xd8, 0xff),
  'image/png': startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  'image/webp': all(ascii('RIFF'), ascii('WEBP', 8)),
  'application/pdf': ascii('%PDF-'),
  'audio/mp4': isoMedia,
  'audio/aac': adts,
  'audio/ogg': ascii('OggS'),
  'audio/webm': startsWith(0x1a, 0x45, 0xdf, 0xa3),
  'audio/mpeg': any(ascii('ID3'), mpegFrame),
};

/** True only when the type is known and the bytes carry its signature. */
export function matchesContentType(contentType: string, head: Uint8Array): boolean {
  const matcher = SIGNATURES[contentType];
  return matcher !== undefined && head.length >= 4 && matcher(head);
}

/** Every content type the policy accepts must have a signature here (tested). */
export function hasSignature(contentType: string): boolean {
  return SIGNATURES[contentType] !== undefined;
}

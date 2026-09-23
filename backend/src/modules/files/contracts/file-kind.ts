/**
 * What kind of thing a stored file is.
 *
 *   IMAGE     photos and pictures
 *   VOICE     a recorded voice message
 *   AUDIO     an audio file — e.g. a recitation recording
 *   DOCUMENT  a document (PDF in V1)
 *
 * Public because the modules that attach files (messaging, later assignments)
 * must name the kinds they accept.
 */
export type FileKind = 'IMAGE' | 'VOICE' | 'AUDIO' | 'DOCUMENT';

export const FILE_KINDS: readonly FileKind[] = Object.freeze([
  'IMAGE',
  'VOICE',
  'AUDIO',
  'DOCUMENT',
]);

export function isFileKind(value: string): value is FileKind {
  return (FILE_KINDS as readonly string[]).includes(value);
}

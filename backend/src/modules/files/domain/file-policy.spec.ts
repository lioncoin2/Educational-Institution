import { MAX_BYTES, buildStorageKey, sanitizeOriginalName, validateUpload } from './file-policy';

describe('upload policy', () => {
  it('accepts an allowed type within the size limit', () => {
    expect(validateUpload('image', 'image/png', 1024)).toBeNull();
  });

  it('rejects a type that is not allowed for the kind', () => {
    expect(validateUpload('image', 'application/x-msdownload', 1024)).toEqual({
      reason: 'content_type_not_allowed',
      contentType: 'application/x-msdownload',
    });
  });

  // A PDF is legitimate as a document and illegitimate as an image: the check is
  // per kind, not a single global allowlist.
  it('rejects an otherwise-allowed type under the wrong kind', () => {
    expect(validateUpload('document', 'application/pdf', 1024)).toBeNull();
    expect(validateUpload('image', 'application/pdf', 1024)).not.toBeNull();
  });

  it('rejects a file over the per-kind ceiling', () => {
    const tooBig = MAX_BYTES.voice_message + 1;
    expect(validateUpload('voice_message', 'audio/ogg', tooBig)).toEqual({
      reason: 'too_large',
      byteSize: tooBig,
      maxBytes: MAX_BYTES.voice_message,
    });
  });

  it('rejects an empty file', () => {
    expect(validateUpload('image', 'image/png', 0)).toEqual({ reason: 'empty_file' });
  });
});

describe('storage keys', () => {
  it('derives the key from ids only, never from the client filename', () => {
    const key = buildStorageKey('image', 'asset-123', new Date(Date.UTC(2026, 0, 5)));
    expect(key).toBe('image/2026/01/asset-123');
  });

  it('zero-pads the month so keys sort lexicographically', () => {
    expect(buildStorageKey('audio', 'a', new Date(Date.UTC(2026, 8, 1)))).toContain('/09/');
  });
});

describe('original name sanitisation', () => {
  it('strips path separators so a name can never become a path', () => {
    expect(sanitizeOriginalName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeOriginalName('a\\b')).toBe('a_b');
  });

  it('strips control characters', () => {
    expect(sanitizeOriginalName('re\u0000port\u001f.pdf')).toBe('report.pdf');
  });

  it('falls back to a placeholder for an empty name', () => {
    expect(sanitizeOriginalName('   ')).toBe('file');
  });

  it('bounds the length', () => {
    expect(sanitizeOriginalName('x'.repeat(500))).toHaveLength(200);
  });
});

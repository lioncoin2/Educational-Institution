import { FILE_KINDS } from '../contracts/file-kind';
import { hasSignature } from './content-signature';
import {
  DISPLAY_NAME_MAX_LENGTH,
  FILE_POLICY,
  MAX_VOICE_DURATION_MS,
  buildStorageKey,
  dispositionFor,
  normalizeContentType,
  sanitizeDisplayName,
  validateUpload,
  type UploadDeclaration,
} from './file-policy';

const png = (overrides: Partial<UploadDeclaration> = {}): UploadDeclaration => ({
  kind: 'IMAGE',
  contentType: 'image/png',
  byteSize: 1024,
  fileName: 'photo.png',
  ...overrides,
});

function errorCode(declaration: UploadDeclaration): string | null {
  const result = validateUpload(declaration);
  return result.ok ? null : result.error.code;
}

describe('upload policy — an allow-list per kind', () => {
  it('accepts an allowed type within the size limit', () => {
    const result = validateUpload(png());
    expect(result.ok && result.value).toMatchObject({
      kind: 'IMAGE',
      contentType: 'image/png',
      byteSize: 1024,
      displayName: 'photo.png',
    });
  });

  it.each([
    ['an executable', 'application/x-msdownload'],
    ['HTML', 'text/html'],
    ['SVG, which can carry script', 'image/svg+xml'],
    [
      'a Word document (Q19)',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    ['nothing at all', ''],
  ])('refuses %s', (_label, contentType) => {
    expect(errorCode(png({ contentType, fileName: 'x' }))).toBe('files.content_type_not_allowed');
  });

  // A PDF is legitimate as a document and illegitimate as an image: the list
  // is per kind, not one global allow-list.
  it('refuses an otherwise-allowed type under the wrong kind', () => {
    expect(
      errorCode(png({ kind: 'DOCUMENT', contentType: 'application/pdf', fileName: 'a.pdf' })),
    ).toBeNull();
    expect(
      errorCode(png({ kind: 'IMAGE', contentType: 'application/pdf', fileName: 'a.pdf' })),
    ).toBe('files.content_type_not_allowed');
  });

  it('normalizes case and ignores parameters in the declared type', () => {
    expect(normalizeContentType(' Image/PNG; charset=binary ')).toBe('image/png');
    expect(errorCode(png({ contentType: 'IMAGE/PNG' }))).toBeNull();
  });

  it('refuses a file over the per-kind ceiling, and says what the ceiling is', () => {
    const result = validateUpload(
      png({
        kind: 'VOICE',
        contentType: 'audio/mp4',
        fileName: 'v.m4a',
        byteSize: FILE_POLICY.VOICE.maxBytes + 1,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('files.too_large');
      expect(result.error.details).toEqual({ maxBytes: FILE_POLICY.VOICE.maxBytes });
    }
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a size of %p', (byteSize) => {
    expect(errorCode(png({ byteSize }))).toBe('files.empty');
  });

  it('never allows an unbounded kind', () => {
    for (const kind of FILE_KINDS) {
      expect(FILE_POLICY[kind].maxBytes).toBeGreaterThan(0);
      expect(FILE_POLICY[kind].maxBytes).toBeLessThanOrEqual(50 * 1024 * 1024);
    }
  });

  // Every accepted type can be verified after upload — no type is let through
  // on the client's word alone.
  it('has a content signature for every type it accepts', () => {
    const types = FILE_KINDS.flatMap((kind) => Object.keys(FILE_POLICY[kind].contentTypes));
    expect(types.filter((type) => !hasSignature(type))).toEqual([]);
  });
});

describe('upload policy — extensions', () => {
  // "photo.html" declared as image/png: stored under a name a browser or an OS
  // would later interpret by its extension.
  it.each(['photo.html', 'photo.exe', 'photo.png.exe', 'invoice.pdf'])(
    'refuses %j declared as a PNG',
    (fileName) => {
      expect(errorCode(png({ fileName }))).toBe('files.extension_mismatch');
    },
  );

  it('accepts any extension registered for the type, case-insensitively', () => {
    expect(errorCode(png({ contentType: 'image/jpeg', fileName: 'a.JPEG' }))).toBeNull();
    expect(errorCode(png({ contentType: 'image/jpeg', fileName: 'a.jpg' }))).toBeNull();
  });

  it('adds the canonical extension to a name without one', () => {
    const result = validateUpload(
      png({ kind: 'VOICE', contentType: 'audio/mp4', fileName: 'recording' }),
    );
    expect(result.ok && result.value.displayName).toBe('recording.m4a');
  });
});

describe('upload policy — metadata', () => {
  const voice = (durationMs: number | null) =>
    png({ kind: 'VOICE', contentType: 'audio/ogg', fileName: 'v.ogg', durationMs });

  it('accepts a plausible voice duration and refuses an implausible one', () => {
    expect(errorCode(voice(12_000))).toBeNull();
    expect(errorCode(voice(null))).toBeNull();
    expect(errorCode(voice(0))).toBe('files.metadata_invalid');
    expect(errorCode(voice(MAX_VOICE_DURATION_MS + 1))).toBe('files.metadata_invalid');
  });

  it('refuses a duration on an image and dimensions on audio', () => {
    expect(errorCode(png({ durationMs: 1000 }))).toBe('files.metadata_invalid');
    expect(
      errorCode(
        png({ kind: 'AUDIO', contentType: 'audio/mpeg', fileName: 'a.mp3', width: 10, height: 10 }),
      ),
    ).toBe('files.metadata_invalid');
  });

  it('requires both image dimensions or neither', () => {
    expect(errorCode(png({ width: 640, height: 480 }))).toBeNull();
    expect(errorCode(png({ width: 640 }))).toBe('files.metadata_invalid');
    expect(errorCode(png({ width: 640, height: 0 }))).toBe('files.metadata_invalid');
  });
});

describe('display names', () => {
  it('replaces path separators, so a name can never become a path', () => {
    expect(sanitizeDisplayName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeDisplayName('a\\b:c')).toBe('a_b_c');
  });

  it('removes control characters', () => {
    expect(sanitizeDisplayName('re\u0000port\u001f\u007f.pdf')).toBe('report.pdf');
  });

  // "invoice<RLO>fdp.exe" displays as "invoiceexe.pdf" in a bidi-aware UI.
  it('removes Unicode direction controls', () => {
    expect(sanitizeDisplayName('invoice‮fdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeDisplayName('a⁦b⁩c‏d؜e')).toBe('abcde');
  });

  it('refuses hidden-file names', () => {
    expect(sanitizeDisplayName('.htaccess')).toBe('htaccess');
  });

  it('keeps Arabic names intact', () => {
    expect(sanitizeDisplayName('تلاوة سورة الفاتحة.m4a')).toBe('تلاوة سورة الفاتحة.m4a');
  });

  it('falls back to a placeholder for an empty name, and bounds the length', () => {
    expect(sanitizeDisplayName('   ')).toBe('file');
    expect([...sanitizeDisplayName('ب'.repeat(500))]).toHaveLength(DISPLAY_NAME_MAX_LENGTH);
  });
});

describe('storage keys', () => {
  it('derives the key from ids only, never from the client file name', () => {
    expect(buildStorageKey('IMAGE', 'asset-123', new Date(Date.UTC(2026, 0, 5)))).toBe(
      'image/2026/01/asset-123',
    );
  });

  it('zero-pads the month so keys sort lexicographically', () => {
    expect(buildStorageKey('AUDIO', 'a', new Date(Date.UTC(2026, 8, 1)))).toBe('audio/2026/09/a');
  });
});

describe('disposition', () => {
  // A valid PDF can still be hostile: documents are never rendered in place.
  it('always downloads documents; shows media inline', () => {
    expect(dispositionFor('DOCUMENT')).toBe('attachment');
    expect(dispositionFor('IMAGE')).toBe('inline');
    expect(dispositionFor('VOICE')).toBe('inline');
  });
});

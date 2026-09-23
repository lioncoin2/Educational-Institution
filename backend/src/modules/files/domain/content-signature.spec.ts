import { matchesContentType } from './content-signature';

const bytes = (...values: Array<number | string>): Uint8Array =>
  Uint8Array.from(
    values.flatMap((value) => (typeof value === 'string' ? [...Buffer.from(value)] : [value])),
  );

describe('content signatures — the stored bytes must be what was declared', () => {
  it.each([
    ['image/png', bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)],
    ['image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe1, 0, 0)],
    ['image/webp', bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 ')],
    ['application/pdf', bytes('%PDF-1.4\n')],
    ['audio/mp4', bytes(0, 0, 0, 0x18, 'ftypM4A ')],
    ['audio/aac', bytes(0xff, 0xf1, 0x50, 0x80)],
    ['audio/ogg', bytes('OggS', 0, 2)],
    ['audio/webm', bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f)],
    ['audio/mpeg', bytes('ID3', 4, 0, 0)],
    ['audio/mpeg', bytes(0xff, 0xfb, 0x90, 0x64)],
  ])('recognizes a real %s', (contentType, head) => {
    expect(matchesContentType(contentType, head)).toBe(true);
  });

  it.each([
    ['an HTML page declared as a PNG', 'image/png', bytes('<!DOCTYPE html>')],
    ['a Windows executable declared as a PDF', 'application/pdf', bytes('MZ', 0x90, 0)],
    ['a PNG declared as a JPEG', 'image/jpeg', bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a)],
    ['a RIFF that is not WebP (a WAV)', 'image/webp', bytes('RIFF', 0, 0, 0, 0, 'WAVEfmt ')],
    ['a script declared as audio', 'audio/ogg', bytes('#!/bin/sh\n')],
  ])('rejects %s', (_label, contentType, head) => {
    expect(matchesContentType(contentType, head)).toBe(false);
  });

  it('rejects a type it has no signature for, and a truncated head', () => {
    expect(matchesContentType('text/html', bytes('<html>'))).toBe(false);
    expect(matchesContentType('image/jpeg', bytes(0xff, 0xd8, 0xff))).toBe(false);
  });
});

import { contentDisposition, parseRange } from './local-transfer.controller';

describe('byte ranges', () => {
  it.each([
    [undefined, null],
    ['bytes=0-3', { start: 0, end: 3 }],
    ['bytes=4-', { start: 4, end: 9 }],
    ['bytes=-3', { start: 7, end: 9 }],
    ['bytes=-30', { start: 0, end: 9 }],
    ['bytes=5-100', { start: 5, end: 9 }],
    ['bytes=0-1,4-5', null], // several ranges: a server may serve it all
    ['items=0-3', null],
    ['bytes=5-2', null],
    ['bytes=-', null],
    ['bytes=10-', 'unsatisfiable'],
    ['bytes=-0', 'unsatisfiable'],
  ] as const)('reads %j of a 10-byte object as %j', (header, expected) => {
    expect(parseRange(header, 10)).toEqual(expected);
  });
});

describe('content disposition', () => {
  it('carries an ASCII fallback and the exact UTF-8 name (RFC 6266)', () => {
    expect(contentDisposition('attachment', 'واجب (1).pdf')).toBe(
      `attachment; filename="____ (1).pdf"; filename*=UTF-8''${encodeURIComponent('واجب')}%20%281%29.pdf`,
    );
  });

  it('cannot be broken out of, whatever the name holds', () => {
    const header = contentDisposition('inline', 'a"; filename="evil.html\r\nX-Injected: 1');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.match(/"/g)).toHaveLength(2);
  });
});

import { isValidTimezone, parseLocalDateTime, resolveLocalToInstant } from './time-resolution';

describe('isValidTimezone', () => {
  it('accepts IANA zone names the platform knows', () => {
    expect(isValidTimezone('Asia/Riyadh')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects fixed offsets, empty, over-long and unknown zones', () => {
    expect(isValidTimezone('+03:00')).toBe(false);
    expect(isValidTimezone('-05:00')).toBe(false);
    expect(isValidTimezone('Z')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('x'.repeat(65))).toBe(false);
  });
});

describe('parseLocalDateTime', () => {
  it('parses a real date/time', () => {
    expect(parseLocalDateTime({ date: '2026-11-01', time: '14:30' })).toEqual({
      year: 2026,
      month: 11,
      day: 1,
      hour: 14,
      minute: 30,
    });
  });

  it('rejects malformed and impossible dates/times', () => {
    expect(parseLocalDateTime({ date: '2026-02-30', time: '09:00' })).toBeNull(); // no Feb 30
    expect(parseLocalDateTime({ date: '2026-13-01', time: '09:00' })).toBeNull(); // no month 13
    expect(parseLocalDateTime({ date: '2026-1-1', time: '09:00' })).toBeNull(); // not zero-padded
    expect(parseLocalDateTime({ date: '2026-11-01', time: '25:00' })).toBeNull(); // no 25:00
    expect(parseLocalDateTime({ date: '2026-11-01', time: '9:00' })).toBeNull(); // not zero-padded
  });
});

describe('resolveLocalToInstant', () => {
  it('resolves a unique local time in a no-DST zone', () => {
    const r = resolveLocalToInstant({ date: '2026-11-01', time: '14:30' }, 'Asia/Riyadh');
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    expect(r.instant.toISOString()).toBe('2026-11-01T11:30:00.000Z'); // +03:00
    expect(r.ambiguous).toBe(false);
  });

  it('resolves a unique local time in a DST zone (summer)', () => {
    const r = resolveLocalToInstant({ date: '2026-07-01', time: '12:00' }, 'Europe/London');
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    expect(r.instant.toISOString()).toBe('2026-07-01T11:00:00.000Z'); // BST +01:00
    expect(r.ambiguous).toBe(false);
  });

  it('rejects an invalid timezone', () => {
    expect(resolveLocalToInstant({ date: '2026-11-01', time: '14:30' }, '+03:00').status).toBe(
      'invalid_timezone',
    );
  });

  it('rejects a malformed/impossible local time', () => {
    expect(resolveLocalToInstant({ date: '2026-02-30', time: '09:00' }, 'UTC').status).toBe(
      'invalid_local',
    );
  });

  it('rejects a nonexistent local time in a spring-forward gap (New York)', () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00, so 02:30 never occurs.
    expect(
      resolveLocalToInstant({ date: '2026-03-08', time: '02:30' }, 'America/New_York').status,
    ).toBe('nonexistent');
  });

  it('rejects a nonexistent local time in a spring-forward gap (London)', () => {
    // 2026-03-29: clocks jump 01:00 -> 02:00, so 01:30 never occurs.
    expect(
      resolveLocalToInstant({ date: '2026-03-29', time: '01:30' }, 'Europe/London').status,
    ).toBe('nonexistent');
  });

  it('resolves an ambiguous fall-back time to the EARLIER instant (New York)', () => {
    // 2026-11-01: clocks drop 02:00 -> 01:00, so 01:30 occurs twice:
    // 01:30 EDT (-04:00) = 05:30Z, then 01:30 EST (-05:00) = 06:30Z. Earlier wins.
    const r = resolveLocalToInstant({ date: '2026-11-01', time: '01:30' }, 'America/New_York');
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    expect(r.ambiguous).toBe(true);
    expect(r.instant.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('resolves an ambiguous fall-back time to the EARLIER instant (London)', () => {
    // 2026-10-25: clocks drop 02:00 -> 01:00, so 01:30 occurs twice:
    // 01:30 BST (+01:00) = 00:30Z, then 01:30 GMT (00:00) = 01:30Z. Earlier wins.
    const r = resolveLocalToInstant({ date: '2026-10-25', time: '01:30' }, 'Europe/London');
    expect(r.status).toBe('resolved');
    if (r.status !== 'resolved') return;
    expect(r.ambiguous).toBe(true);
    expect(r.instant.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('always resolves to a minute-aligned instant (seconds and millis zero)', () => {
    const r = resolveLocalToInstant({ date: '2026-07-01', time: '12:00' }, 'Asia/Riyadh');
    if (r.status !== 'resolved') throw new Error('expected resolved');
    expect(r.instant.getUTCSeconds()).toBe(0);
    expect(r.instant.getUTCMilliseconds()).toBe(0);
  });
});

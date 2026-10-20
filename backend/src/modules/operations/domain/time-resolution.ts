/**
 * Time resolution for scheduled lessons — turning a wall-clock date/time in a
 * named zone into a single UTC instant, DST-correctly.
 *
 * A lesson is scheduled as a WALL-CLOCK time ("2026-11-01 at 14:30") in an IANA
 * zone, not as an instant. Converting the two into a UTC instant is not a
 * one-to-one map:
 *
 *   - a spring-forward GAP skips an hour, so some local times NEVER occur
 *     (02:30 on a night the clocks jump 02:00 → 03:00 does not exist); and
 *   - a fall-back FOLD repeats an hour, so some local times occur TWICE
 *     (01:30 on a night the clocks drop 02:00 → 01:00 happens at two instants).
 *
 * This module detects both explicitly from the zone's own offsets — it never
 * relies on `Date` string parsing or a guessed offset to make the decision. A
 * gap is rejected (the caller must pick a real time); a fold resolves to the
 * EARLIER of the two instants, deterministically (the owner's approved rule).
 *
 * It is a PURE, standalone resolver. It deliberately does NOT import the
 * notifications module's quiet-hours timezone helper: operations must not reach
 * into another module's internal domain (dependency-rules.md). It reuses the
 * same proven *pattern* — IANA names only, resolved through the built-in `Intl`
 * which carries the platform's tz database and is DST-correct — not its code.
 */

/** The stored wall-clock a lesson is scheduled at. */
export interface LocalDateTime {
  /** Calendar date, 'YYYY-MM-DD'. */
  readonly date: string;
  /** Time of day, 'HH:MM', 24-hour. */
  readonly time: string;
}

/** The outcome of resolving a local wall-clock time in a zone to an instant. */
export type TimeResolution =
  | { readonly status: 'resolved'; readonly instant: Date; readonly ambiguous: boolean }
  /** The timezone is not an IANA zone the platform knows (or is a fixed offset). */
  | { readonly status: 'invalid_timezone' }
  /** The date/time is malformed or not a real calendar date (e.g. 2026-02-30). */
  | { readonly status: 'invalid_local' }
  /** A real-looking local time that a DST spring-forward gap skips — it never occurs. */
  | { readonly status: 'nonexistent' };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const MAX_TIMEZONE_LENGTH = 64;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An IANA zone the platform's `Intl` knows — `Asia/Riyadh`, `UTC`, and the
 * like. Fixed offsets ('Z', '+03:00') are deliberately refused: a wall-clock
 * schedule is only DST-correct against a named zone. (Same rule as the
 * institution timezone; implemented here so operations stays self-contained.)
 */
export function isValidTimezone(timezone: string): boolean {
  if (
    typeof timezone !== 'string' ||
    timezone.length === 0 ||
    timezone.length > MAX_TIMEZONE_LENGTH
  ) {
    return false;
  }
  // An IANA name never begins with a sign; reject a fixed offset before asking
  // the runtime (some `Intl` builds would otherwise accept '+03:00').
  if (/^[+-]/.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  readonly year: number;
  readonly month: number; // 1..12
  readonly day: number; // 1..31
  readonly hour: number; // 0..23
  readonly minute: number; // 0..59
}

/**
 * Parse 'YYYY-MM-DD' + 'HH:MM' into components, or null if malformed or not a
 * real calendar date. The round-trip through `Date.UTC` rejects impossible
 * dates (2026-02-30 rolls over, so its parts no longer match).
 */
export function parseLocalDateTime(local: LocalDateTime): LocalParts | null {
  const date = DATE.exec(local.date);
  const time = TIME.exec(local.time);
  if (date === null || time === null) return null;
  const parts: LocalParts = {
    year: Number(date[1]),
    month: Number(date[2]),
    day: Number(date[3]),
    hour: Number(time[1]),
    minute: Number(time[2]),
  };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return null;
  const roundTrip = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    roundTrip.getUTCFullYear() !== parts.year ||
    roundTrip.getUTCMonth() !== parts.month - 1 ||
    roundTrip.getUTCDate() !== parts.day
  ) {
    return null;
  }
  return parts;
}

/** The wall-clock parts of `utcMs` as read in `zone` (seconds dropped). */
function partsInZone(utcMs: number, zone: string): LocalParts {
  const fields = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(utcMs));
  const read = (type: string): number => Number(fields.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

/** Milliseconds `zone` is ahead of UTC at the instant `utcMs` (local = utc + offset). */
function offsetMsAt(utcMs: number, zone: string): number {
  const p = partsInZone(utcMs, zone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  return asIfUtc - utcMs;
}

function sameWallClock(a: LocalParts, b: LocalParts): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

/**
 * Resolve a wall-clock local time in an IANA zone to a UTC instant.
 *
 * Method (offset-bracketing, no `Date` string parsing):
 *   1. Take the local parts "as if UTC" — `guessMs`.
 *   2. Read the zone's offset a day BEFORE and a day AFTER `guessMs`. DST
 *      transitions are months apart, so at most one lies between them, and the
 *      two offsets bracket it.
 *   3. Each offset yields a candidate instant `guessMs - offset`. A candidate
 *      is VALID only if rendering it back in the zone reproduces the requested
 *      wall clock exactly.
 *   4. No valid candidate → the time is skipped by a spring-forward gap
 *      (`nonexistent`). One → unambiguous. Two (a fall-back fold) → `ambiguous`,
 *      and the EARLIER instant is chosen.
 *
 * Seconds and milliseconds are always zero (lessons are minute-precision).
 */
export function resolveLocalToInstant(local: LocalDateTime, timezone: string): TimeResolution {
  if (!isValidTimezone(timezone)) return { status: 'invalid_timezone' };
  const parts = parseLocalDateTime(local);
  if (parts === null) return { status: 'invalid_local' };

  const guessMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  const offsetBefore = offsetMsAt(guessMs - DAY_MS, timezone);
  const offsetAfter = offsetMsAt(guessMs + DAY_MS, timezone);

  const candidates = Array.from(new Set([guessMs - offsetBefore, guessMs - offsetAfter]));
  const valid = candidates
    .filter((ms) => sameWallClock(partsInZone(ms, timezone), parts))
    .sort((a, b) => a - b);

  if (valid.length === 0) return { status: 'nonexistent' };
  return { status: 'resolved', instant: new Date(valid[0]), ambiguous: valid.length > 1 };
}

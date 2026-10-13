/**
 * Quiet hours — when PUSH is held back, and nothing else.
 *
 * The institution may set a nightly window in which push is not sent; a person
 * may override it for themselves. Quiet hours suppress PUSH only: the record is
 * always stored in the notification center, and realtime is untouched — exactly
 * like turning push off for a category, but by the clock (see
 * `domain/preferences.ts` for the channel model this rides on).
 *
 * The owner's Q6 decisions this encodes (docs/owner-decision-register.md):
 *
 *   - A user override fully REPLACES the institution window for that user:
 *     they may widen it, narrow it, or disable quiet hours entirely. Push is a
 *     courtesy and the record is stored regardless, so a user who disables
 *     their quiet hours only receives more push to their own device.
 *   - Quiet hours are evaluated in the user's own timezone. When a user has no
 *     timezone, or an invalid one, evaluation FALLS BACK to the institution's
 *     declared timezone — never a guessed or hard-coded zone. With no
 *     institution timezone either, quiet hours simply do not apply.
 *
 * There is NO urgent / always-deliver bypass here. Until a separate policy
 * defines one, every suppressed push is suppressed the same way.
 *
 * Pure: time is passed in (`now`), timezones are resolved with the built-in
 * `Intl` (DST-correct, because it resolves the wall-clock time in the zone for
 * the given instant), and every ambiguity resolves to "do not suppress" — the
 * record is in the inbox whatever happens here.
 */

/** 'HH:MM', 24-hour. The stored shape of a window boundary. */
const TIME_OF_DAY = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function isValidTimeOfDay(value: string): boolean {
  return TIME_OF_DAY.test(value);
}

/** Minutes since local midnight for a valid 'HH:MM', or null if malformed. */
export function parseTimeOfDay(value: string): number | null {
  if (!isValidTimeOfDay(value)) return null;
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * A nightly window. `start` and `end` are 'HH:MM'. `start < end` is a daytime
 * window; `start > end` is overnight (e.g. 21:00–07:00). `start === end` is
 * rejected at validation — a window must have a length.
 */
export interface QuietHoursWindow {
  readonly start: string;
  readonly end: string;
}

export function isValidWindow(window: QuietHoursWindow): boolean {
  return (
    isValidTimeOfDay(window.start) && isValidTimeOfDay(window.end) && window.start !== window.end
  );
}

/**
 * A timezone the institution or a user declared. Valid means an IANA zone the
 * platform's `Intl` knows — `Asia/Baghdad`, `UTC`, and the like. Fixed offsets
 * ('Z', '+03:00') are deliberately NOT accepted: a window is a wall-clock
 * policy, which only a named zone makes DST-correct.
 */
export function isValidTimezone(timezone: string): boolean {
  if (typeof timezone !== 'string' || timezone.length === 0 || timezone.length > 64) {
    return false;
  }
  // IANA names only. Some runtimes' `Intl` also accepts a fixed offset
  // ('+03:00'), which a wall-clock DST policy must not use — an IANA name never
  // begins with a sign, so reject those before asking the runtime.
  if (/^[+-]/.test(timezone)) return false;
  try {
    // Throws RangeError for a zone the runtime does not know.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The wall-clock minute of the day at `now` in `timeZone`, 0..1439. DST is
 * handled by `Intl`: the same instant is a different wall clock in a zone that
 * has just sprung forward or fallen back. `hourCycle: 'h23'` keeps midnight at
 * 00:00, never 24:00.
 */
export function minutesOfDayInZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return hour * 60 + minute;
}

/**
 * Whether `minutes` falls inside the window [start, end): start inclusive, end
 * exclusive, so a 21:00–07:00 window is quiet at 21:00 and open again at 07:00.
 * An overnight window (start > end) wraps midnight.
 */
export function isWithinWindow(minutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return minutes >= startMinutes && minutes < endMinutes;
  return minutes >= startMinutes || minutes < endMinutes;
}

/** The institution-wide policy. `enabled` false means "no institution quiet hours". */
export interface InstitutionQuietHours {
  readonly enabled: boolean;
  readonly window: QuietHoursWindow;
  readonly timezone: string;
}

/**
 * One person's quiet-hours choice, and the timezone their hours are read in.
 *
 *   INHERIT    follow the institution window (the default)
 *   DISABLED   no quiet hours for me, whatever the institution sets
 *   CUSTOM     my own window, which replaces the institution's
 */
export type UserQuietHoursPreference =
  | { readonly mode: 'INHERIT' }
  | { readonly mode: 'DISABLED' }
  | { readonly mode: 'CUSTOM'; readonly window: QuietHoursWindow };

export interface UserNotificationSettings {
  /** An IANA zone, or null when the user has set none. */
  readonly timezone: string | null;
  readonly quietHours: UserQuietHoursPreference;
}

/** No timezone, inherit the institution window — what a person starts with. */
export const DEFAULT_USER_NOTIFICATION_SETTINGS: UserNotificationSettings = Object.freeze({
  timezone: null,
  quietHours: Object.freeze({ mode: 'INHERIT' as const }),
});

/** The window actually in force for this user, or null if none applies. */
function activeWindow(
  institution: InstitutionQuietHours | null,
  user: UserNotificationSettings,
): QuietHoursWindow | null {
  switch (user.quietHours.mode) {
    case 'DISABLED':
      return null;
    case 'CUSTOM':
      return user.quietHours.window;
    case 'INHERIT':
      return institution !== null && institution.enabled ? institution.window : null;
  }
}

/**
 * The zone the window is read in: the user's if valid, else the institution's
 * if valid, else none. This is the "fall back to the institution timezone"
 * rule — never a guessed zone.
 */
function evaluationZone(
  institution: InstitutionQuietHours | null,
  user: UserNotificationSettings,
): string | null {
  if (user.timezone !== null && isValidTimezone(user.timezone)) return user.timezone;
  if (institution !== null && isValidTimezone(institution.timezone)) return institution.timezone;
  return null;
}

/**
 * Whether push should be held for this user at this instant. PUSH ONLY — the
 * caller still stores the record and still decides realtime. Any missing or
 * malformed input resolves to false (deliver): the notification is in the
 * inbox regardless, so the safe failure is to let the push through.
 */
export function quietHoursSuppressesPush(
  institution: InstitutionQuietHours | null,
  user: UserNotificationSettings,
  now: Date,
): boolean {
  const window = activeWindow(institution, user);
  if (window === null) return false;
  const zone = evaluationZone(institution, user);
  if (zone === null) return false;
  const start = parseTimeOfDay(window.start);
  const end = parseTimeOfDay(window.end);
  if (start === null || end === null) return false;
  return isWithinWindow(minutesOfDayInZone(now, zone), start, end);
}

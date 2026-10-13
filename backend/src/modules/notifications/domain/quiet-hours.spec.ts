import {
  DEFAULT_USER_NOTIFICATION_SETTINGS,
  isValidTimeOfDay,
  isValidTimezone,
  isValidWindow,
  isWithinWindow,
  minutesOfDayInZone,
  parseTimeOfDay,
  quietHoursSuppressesPush,
  type InstitutionQuietHours,
  type UserNotificationSettings,
} from './quiet-hours';

describe('quiet hours', () => {
  describe('time-of-day validation', () => {
    it.each(['00:00', '09:30', '21:00', '23:59'])('accepts %s', (value) => {
      expect(isValidTimeOfDay(value)).toBe(true);
      expect(parseTimeOfDay(value)).not.toBeNull();
    });

    it.each(['24:00', '9:30', '21:60', '', '7am', '21:0'])('rejects %s', (value) => {
      expect(isValidTimeOfDay(value)).toBe(false);
      expect(parseTimeOfDay(value)).toBeNull();
    });

    it('parses to minutes since midnight', () => {
      expect(parseTimeOfDay('00:00')).toBe(0);
      expect(parseTimeOfDay('07:00')).toBe(420);
      expect(parseTimeOfDay('21:30')).toBe(1290);
      expect(parseTimeOfDay('23:59')).toBe(1439);
    });

    it('requires a window to have a length', () => {
      expect(isValidWindow({ start: '21:00', end: '07:00' })).toBe(true);
      expect(isValidWindow({ start: '09:00', end: '17:00' })).toBe(true);
      expect(isValidWindow({ start: '21:00', end: '21:00' })).toBe(false);
      expect(isValidWindow({ start: '9:00', end: '17:00' })).toBe(false);
    });
  });

  describe('timezone validation (IANA only)', () => {
    it.each(['UTC', 'Asia/Baghdad', 'America/New_York', 'Europe/London'])(
      'accepts the IANA zone %s',
      (zone) => expect(isValidTimezone(zone)).toBe(true),
    );

    it.each(['', 'Mars/Phobos', 'not a zone', '+03:00', 'Z', 'GMT+3:00'])('rejects %s', (zone) =>
      expect(isValidTimezone(zone)).toBe(false),
    );
  });

  describe('containment (start inclusive, end exclusive)', () => {
    // A daytime window.
    it('holds a daytime window', () => {
      const [start, end] = [540, 1020]; // 09:00–17:00
      expect(isWithinWindow(540, start, end)).toBe(true); // 09:00 inclusive
      expect(isWithinWindow(600, start, end)).toBe(true); // 10:00
      expect(isWithinWindow(1020, start, end)).toBe(false); // 17:00 exclusive
      expect(isWithinWindow(539, start, end)).toBe(false); // 08:59
    });

    // An overnight window wraps midnight.
    it('holds an overnight window', () => {
      const [start, end] = [1260, 420]; // 21:00–07:00
      expect(isWithinWindow(1260, start, end)).toBe(true); // 21:00 inclusive
      expect(isWithinWindow(1380, start, end)).toBe(true); // 23:00
      expect(isWithinWindow(0, start, end)).toBe(true); // 00:00
      expect(isWithinWindow(240, start, end)).toBe(true); // 04:00
      expect(isWithinWindow(420, start, end)).toBe(false); // 07:00 exclusive
      expect(isWithinWindow(1259, start, end)).toBe(false); // 20:59
    });

    it('an empty window contains nothing', () => {
      expect(isWithinWindow(600, 600, 600)).toBe(false);
    });
  });

  describe('wall-clock in a zone, DST-aware', () => {
    // The SAME instant is a different wall clock in a zone that observes DST.
    it('reads the local minute of day for an instant', () => {
      const instant = new Date('2025-01-15T06:30:00Z');
      expect(minutesOfDayInZone(instant, 'UTC')).toBe(390); // 06:30
      expect(minutesOfDayInZone(instant, 'America/New_York')).toBe(90); // 01:30 EST (−5)
    });

    it('keeps midnight at 00:00, never 24:00', () => {
      expect(minutesOfDayInZone(new Date('2025-06-01T00:00:00Z'), 'UTC')).toBe(0);
    });
  });

  // The institution window, read in the right zone, with no user override.
  const institution: InstitutionQuietHours = {
    enabled: true,
    window: { start: '01:00', end: '02:00' },
    timezone: 'America/New_York',
  };
  const inherits: UserNotificationSettings = DEFAULT_USER_NOTIFICATION_SETTINGS;

  describe('DST changes the decision for the same wall-clock instant', () => {
    // 06:30 UTC is 01:30 in New York in winter (EST, −5) but 02:30 in summer
    // (EDT, −4): the 01:00–02:00 window catches one and not the other.
    const winter = new Date('2025-01-15T06:30:00Z');
    const summer = new Date('2025-07-15T06:30:00Z');

    it('suppresses in winter (01:30 local, inside the window)', () => {
      expect(quietHoursSuppressesPush(institution, inherits, winter)).toBe(true);
    });

    it('does not suppress in summer (02:30 local, past the window)', () => {
      expect(quietHoursSuppressesPush(institution, inherits, summer)).toBe(false);
    });
  });

  describe('user override — the user fully replaces the institution window', () => {
    const now = new Date('2025-01-15T06:30:00Z'); // 01:30 New York (inside institution window)

    it('INHERIT follows the institution window', () => {
      expect(
        quietHoursSuppressesPush(
          institution,
          { timezone: null, quietHours: { mode: 'INHERIT' } },
          now,
        ),
      ).toBe(true);
    });

    it('DISABLED means no quiet hours, even inside the institution window', () => {
      expect(
        quietHoursSuppressesPush(
          institution,
          { timezone: null, quietHours: { mode: 'DISABLED' } },
          now,
        ),
      ).toBe(false);
    });

    it('CUSTOM replaces the institution window with the user’s own', () => {
      // The user is awake 01:00–02:00 but quiet 03:00–04:00: now (01:30) is NOT quiet for them.
      const user: UserNotificationSettings = {
        timezone: null,
        quietHours: { mode: 'CUSTOM', window: { start: '03:00', end: '04:00' } },
      };
      expect(quietHoursSuppressesPush(institution, user, now)).toBe(false);
      // And an instant inside their custom window (03:30 NY = 08:30 UTC in winter) is quiet.
      expect(quietHoursSuppressesPush(institution, user, new Date('2025-01-15T08:30:00Z'))).toBe(
        true,
      );
    });

    it('a user with no override and a disabled institution policy is never quiet', () => {
      const disabled: InstitutionQuietHours = { ...institution, enabled: false };
      expect(quietHoursSuppressesPush(disabled, inherits, now)).toBe(false);
      expect(quietHoursSuppressesPush(null, inherits, now)).toBe(false);
    });
  });

  describe('timezone resolution — fall back to the institution zone', () => {
    const now = new Date('2025-01-15T06:30:00Z'); // 01:30 New York

    it('uses the user’s own timezone when it is valid', () => {
      // In UTC it is 06:30, outside 01:00–02:00; so a UTC user is not quiet.
      const user: UserNotificationSettings = { timezone: 'UTC', quietHours: { mode: 'INHERIT' } };
      expect(quietHoursSuppressesPush(institution, user, now)).toBe(false);
    });

    it('falls back to the institution timezone when the user has none', () => {
      const user: UserNotificationSettings = { timezone: null, quietHours: { mode: 'INHERIT' } };
      expect(quietHoursSuppressesPush(institution, user, now)).toBe(true); // 01:30 NY
    });

    it('falls back to the institution timezone when the user’s is invalid', () => {
      const user: UserNotificationSettings = {
        timezone: 'Mars/Phobos',
        quietHours: { mode: 'INHERIT' },
      };
      expect(quietHoursSuppressesPush(institution, user, now)).toBe(true); // 01:30 NY
    });

    it('does not suppress when there is no usable zone anywhere', () => {
      // A user with a custom window but no timezone, and no institution policy to
      // borrow a zone from: nothing to anchor the window, so push is delivered.
      const user: UserNotificationSettings = {
        timezone: null,
        quietHours: { mode: 'CUSTOM', window: { start: '00:00', end: '23:59' } },
      };
      expect(quietHoursSuppressesPush(null, user, now)).toBe(false);
    });

    it('does not suppress when the institution zone is invalid and the user has none', () => {
      const bad: InstitutionQuietHours = { ...institution, timezone: 'Nowhere/Nothing' };
      const user: UserNotificationSettings = { timezone: null, quietHours: { mode: 'INHERIT' } };
      expect(quietHoursSuppressesPush(bad, user, now)).toBe(false);
    });
  });

  // There is no urgent / always-deliver path: suppression never branches on the
  // notification — it is purely window-and-mute. (Mute is covered in
  // conversation-mute.spec.ts.) This test pins the absence: a user inside the
  // window is suppressed regardless of any other input.
  it('has no urgent bypass — being inside the window always suppresses', () => {
    const now = new Date('2025-01-15T06:30:00Z');
    expect(quietHoursSuppressesPush(institution, inherits, now)).toBe(true);
  });
});

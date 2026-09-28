import { ReconcilerWatch, WATCH_ENTRY_LIMIT } from './live-reconciler-watch';

const SESSION = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-09-27T09:00:00.000Z');

const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

/**
 * The targeted watch's memory (live.md §11.4; P7.1): who is under
 * enforcement — and, apart, which foreign identities are looked for again.
 * A foreign identity is never armed, never among the people, and however
 * many a client makes, never pushes an enforcement entry out. The accounts
 * behind breaching foreign identities (P7.2 decision R1) are armed apart
 * from their own identities' corrections, either way round.
 */
describe('the reconciler’s watch', () => {
  let watch: ReconcilerWatch;

  beforeEach(() => {
    watch = new ReconcilerWatch();
  });

  it('keeps foreign identities apart from the people under enforcement', () => {
    watch.remember({ sessionId: SESSION, userId: 'student-1', until: at(60), applied: true });
    watch.rememberForeign(SESSION, 'student-1#mic', at(60));

    expect(watch.watchedIn(SESSION, NOW)).toEqual(['student-1']);
    expect(watch.foreignIn(SESSION, NOW)).toEqual(['student-1#mic']);
    expect(watch.armed(SESSION, 'student-1', NOW)).toBe(true);
    // Never armed: nothing a foreign identity does is a violation.
    expect(watch.armed(SESSION, 'student-1#mic', NOW)).toBe(false);
    expect(watch.foreignIn(OTHER, NOW)).toEqual([]);
  });

  it('looks for a foreign identity until its window ends, and extends the window when told again', () => {
    watch.rememberForeign(SESSION, 'student-1#mic', at(60));
    expect(watch.foreignIn(SESSION, at(59))).toEqual(['student-1#mic']);

    watch.rememberForeign(SESSION, 'student-1#mic', at(120));
    expect(watch.foreignIn(SESSION, at(60))).toEqual(['student-1#mic']);
    expect(watch.foreignIn(SESSION, at(120))).toEqual([]);
    // Dropped on the way, not merely skipped.
    expect(watch.foreignIn(SESSION, at(0))).toEqual([]);
  });

  it('drops a session’s foreign identities, and its people, when the session ends', () => {
    for (const sessionId of [SESSION, OTHER]) {
      watch.remember({ sessionId, userId: 'student-1', until: at(60), applied: true });
      watch.rememberForeign(sessionId, 'student-1#mic', at(60));
    }

    watch.forget(SESSION);
    expect(watch.watchedIn(SESSION, NOW)).toEqual([]);
    expect(watch.foreignIn(SESSION, NOW)).toEqual([]);
    expect(watch.foreignIn(OTHER, NOW)).toEqual(['student-1#mic']);

    watch.keepOnly(new Set([SESSION]));
    expect(watch.watchedIn(OTHER, NOW)).toEqual([]);
    expect(watch.foreignIn(OTHER, NOW)).toEqual([]);
  });

  it('holds at most WATCH_ENTRY_LIMIT foreign identities, the oldest dropped — and never an enforcement entry for them', () => {
    watch.remember({ sessionId: SESSION, userId: 'student-1', until: at(60), applied: true });
    for (let n = 0; n <= WATCH_ENTRY_LIMIT; n += 1) {
      watch.rememberForeign(SESSION, `student-2#${n}`, at(60));
    }

    const foreign = watch.foreignIn(SESSION, NOW);
    expect(foreign).toHaveLength(WATCH_ENTRY_LIMIT);
    expect(foreign[0]).toBe('student-2#1');
    expect(foreign.at(-1)).toBe(`student-2#${WATCH_ENTRY_LIMIT}`);
    expect(watch.armed(SESSION, 'student-1', NOW)).toBe(true);
    expect(watch.watchedIn(SESSION, NOW)).toEqual(['student-1']);
  });

  it('arms an account’s foreign sightings apart from its own identity’s corrections — neither arms the other', () => {
    watch.armForeign(SESSION, 'student-1', at(60));
    expect(watch.foreignArmed(SESSION, 'student-1', NOW)).toBe(true);
    expect(watch.armed(SESSION, 'student-1', NOW)).toBe(false);

    watch.remember({ sessionId: SESSION, userId: 'student-2', until: at(60), applied: true });
    expect(watch.armed(SESSION, 'student-2', NOW)).toBe(true);
    expect(watch.foreignArmed(SESSION, 'student-2', NOW)).toBe(false);

    // Both are under enforcement, each once; until their windows end.
    watch.remember({ sessionId: SESSION, userId: 'student-1', until: at(60), applied: false });
    expect(watch.watchedIn(SESSION, NOW)).toEqual(['student-2', 'student-1']);
    expect(watch.foreignArmed(SESSION, 'student-1', at(60))).toBe(false);
    expect(watch.foreignArmed(OTHER, 'student-1', NOW)).toBe(false);
  });

  it('says whether anything at all is watched in a session — someone under enforcement, a foreign identity, or an armed account', () => {
    expect(watch.anyIn(SESSION, NOW)).toBe(false);
    watch.rememberForeign(SESSION, 'student-1#mic', at(10));
    expect(watch.anyIn(SESSION, NOW)).toBe(true);
    expect(watch.anyIn(SESSION, at(10))).toBe(false);

    watch.armForeign(SESSION, 'student-1', at(20));
    expect(watch.anyIn(SESSION, at(10))).toBe(true);
    watch.remember({ sessionId: SESSION, userId: 'student-2', until: at(30), applied: false });
    expect(watch.anyIn(SESSION, at(20))).toBe(true);
    expect(watch.anyIn(SESSION, at(30))).toBe(false);
    expect(watch.anyIn(OTHER, NOW)).toBe(false);
  });

  it('drops a session’s armed accounts with the rest when it ends', () => {
    watch.armForeign(SESSION, 'student-1', at(60));
    watch.armForeign(OTHER, 'student-1', at(60));

    watch.forget(SESSION);
    expect(watch.foreignArmed(SESSION, 'student-1', NOW)).toBe(false);
    expect(watch.foreignArmed(OTHER, 'student-1', NOW)).toBe(true);

    watch.keepOnly(new Set([SESSION]));
    expect(watch.foreignArmed(OTHER, 'student-1', NOW)).toBe(false);
  });
});

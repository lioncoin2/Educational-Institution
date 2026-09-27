import { asId } from '../../../shared';
import { MAX_CONCURRENT_SPEAKERS as LIMIT } from './live-limits';
import {
  ALLOWED_TRANSITIONS,
  MAX_CONCURRENT_SPEAKERS,
  OPEN_STATES,
  SPEAKER_REQUEST_STATES,
  TERMINAL_STATES,
  canTransition,
  isOpen,
  judgeTransition,
  lastOpenState,
  newSpeakerRequest,
  queueOrder,
  transition,
  type SpeakerRequest,
  type SpeakerRequestState,
} from './speaker-request';

const at = (ms: number) => new Date(ms);

const request = (id: string, state: SpeakerRequestState, requestedAt = 1): SpeakerRequest => ({
  id: asId<'SpeakerRequest'>(id),
  sessionId: 'session-1',
  userId: `user-${id}`,
  state,
  requestedAt: at(requestedAt),
  grantedAt: state === 'granted' ? at(requestedAt + 1) : null,
  decidedAt: state === 'pending' ? null : at(requestedAt + 1),
  decidedBy: state === 'pending' || state === 'expired' ? null : 'someone',
});

/** Who acts on a move to `to`: nobody for an expiry, a person for anything else. */
const actorFor = (to: SpeakerRequestState) => (to === 'expired' ? null : 'teacher-1');

describe('speaker request transitions', () => {
  it('allows exactly the moves of live.md §5.1, over every (from, to) pair', () => {
    const allowed = SPEAKER_REQUEST_STATES.flatMap((from) =>
      SPEAKER_REQUEST_STATES.filter((to) => canTransition(from, to)).map((to) => `${from}→${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        'pending→granted',
        'pending→declined',
        'pending→withdrawn',
        // The system: the session ended, or the requester may no longer take part.
        'pending→expired',
        'granted→revoked',
        // A speaker may yield the floor themself.
        'granted→withdrawn',
        'granted→expired',
      ].sort(),
    );
    // The table is the one place moves are defined: canTransition reads it.
    for (const from of SPEAKER_REQUEST_STATES) {
      for (const to of SPEAKER_REQUEST_STATES) {
        expect(canTransition(from, to)).toBe(ALLOWED_TRANSITIONS[from].includes(to));
      }
    }
  });

  it('knows six states: two open, four terminal', () => {
    expect([...SPEAKER_REQUEST_STATES].sort()).toEqual(
      ['declined', 'expired', 'granted', 'pending', 'revoked', 'withdrawn'].sort(),
    );
    expect([...OPEN_STATES].sort()).toEqual(['granted', 'pending']);
    expect([...TERMINAL_STATES].sort()).toEqual(['declined', 'expired', 'revoked', 'withdrawn']);
    for (const state of TERMINAL_STATES) {
      expect(SPEAKER_REQUEST_STATES.filter((to) => canTransition(state, to))).toEqual([]);
      expect(isOpen(request('x', state))).toBe(false);
    }
    for (const state of OPEN_STATES) expect(isOpen(request('x', state))).toBe(true);
  });

  it('records who decided and when; a grant also records when the floor was given', () => {
    const granted = transition(request('1', 'pending'), 'granted', at(10), 'teacher-1');
    expect(granted).toMatchObject({
      state: 'granted',
      grantedAt: at(10),
      decidedAt: at(10),
      decidedBy: 'teacher-1',
    });
    const yielded = transition(granted as SpeakerRequest, 'withdrawn', at(20), 'user-1');
    expect(yielded).toMatchObject({
      state: 'withdrawn',
      grantedAt: at(10),
      decidedAt: at(20),
      decidedBy: 'user-1',
    });
  });

  it('leaves decidedBy null exactly while pending and once expired (R3)', () => {
    const fresh = newSpeakerRequest({
      id: asId<'SpeakerRequest'>('r'),
      sessionId: 'session-1',
      userId: 'student-1',
      at: at(5),
    });
    expect(fresh).toEqual({
      id: 'r',
      sessionId: 'session-1',
      userId: 'student-1',
      state: 'pending',
      requestedAt: at(5),
      grantedAt: null,
      decidedAt: null,
      decidedBy: null,
    });
    for (const from of OPEN_STATES) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        const moved = transition(request('1', from), to, at(30), actorFor(to));
        expect({ from, to, decidedBy: moved?.decidedBy === null }).toEqual({
          from,
          to,
          decidedBy: to === 'expired',
        });
        expect(moved?.decidedAt).toEqual(at(30));
      }
    }
  });

  it('refuses an actor on an expiry, and a move nobody made — as the database’s CHECK would', () => {
    expect(() => transition(request('1', 'pending'), 'expired', at(5), 'teacher-1')).toThrow(
      RangeError,
    );
    expect(() => transition(request('1', 'granted'), 'revoked', at(5), null)).toThrow(RangeError);
  });

  it('keeps when the floor was given through an expiry', () => {
    const expired = transition(request('1', 'granted'), 'expired', at(50), null);
    expect(expired).toMatchObject({ state: 'expired', grantedAt: at(2), decidedBy: null });
  });

  it('returns null rather than corrupting state on an illegal transition', () => {
    const original = request('1', 'pending');
    expect(transition(original, 'revoked', at(5), 'teacher-1')).toBeNull();
    expect(transition(request('2', 'expired'), 'withdrawn', at(5), 'user-2')).toBeNull();
    expect(original.state).toBe('pending');
  });

  it('defines repeats in one place: the target state is unchanged, a move outside the table is invalid', () => {
    expect(judgeTransition('granted', 'granted')).toBe('unchanged');
    expect(judgeTransition('declined', 'declined')).toBe('unchanged');
    expect(judgeTransition('expired', 'expired')).toBe('unchanged');
    expect(judgeTransition('pending', 'granted')).toBe('apply');
    expect(judgeTransition('granted', 'expired')).toBe('apply');
    expect(judgeTransition('declined', 'granted')).toBe('invalid');
    expect(judgeTransition('revoked', 'withdrawn')).toBe('invalid');
    expect(judgeTransition('expired', 'granted')).toBe('invalid');
  });

  it('tells which open state a closed request left — the `from` of a withdrawal or an expiry', () => {
    const withdrawn = transition(request('1', 'pending'), 'withdrawn', at(9), 'user-1');
    const yielded = transition(request('2', 'granted'), 'withdrawn', at(9), 'user-2');
    const expiredPending = transition(request('3', 'pending'), 'expired', at(9), null);
    const expiredGranted = transition(request('4', 'granted'), 'expired', at(9), null);
    expect(
      [withdrawn, yielded, expiredPending, expiredGranted].map((r) => lastOpenState(r!)),
    ).toEqual(['pending', 'granted', 'pending', 'granted']);
    expect(lastOpenState(request('5', 'pending'))).toBe('pending');
    expect(lastOpenState(request('6', 'granted'))).toBe('granted');
  });
});

describe('the queue order', () => {
  it('is first come, first served — then by id, so equal instants never reorder', () => {
    const hands = [
      request('c', 'pending', 30),
      request('b', 'pending', 10),
      request('a', 'pending', 10),
    ];
    expect([...hands].sort(queueOrder).map((hand) => hand.id)).toEqual(['a', 'b', 'c']);
    // A keyset position compares the same way, so a page resumes exactly after it.
    expect(
      queueOrder(request('b', 'pending', 10), { requestedAt: at(10), id: 'a' }),
    ).toBeGreaterThan(0);
    expect(queueOrder(request('a', 'pending', 10), { requestedAt: at(10), id: 'a' })).toBe(0);
  });

  it('caps concurrent speakers at a technical limit (Q4), the one in live-limits', () => {
    expect(MAX_CONCURRENT_SPEAKERS).toBe(4);
    expect(MAX_CONCURRENT_SPEAKERS).toBe(LIMIT);
  });
});

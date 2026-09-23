import { asId } from '../../../shared';
import {
  MAX_CONCURRENT_SPEAKERS,
  TERMINAL_STATES,
  canTransition,
  isOpen,
  judgeTransition,
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
  grantedAt: null,
  decidedAt: null,
  decidedBy: null,
});

const ALL: readonly SpeakerRequestState[] = [
  'pending',
  'granted',
  'declined',
  'revoked',
  'withdrawn',
];

describe('speaker request transitions', () => {
  it('allows exactly the moves in the table', () => {
    const allowed = ALL.flatMap((from) =>
      ALL.filter((to) => canTransition(from, to)).map((to) => `${from}→${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        'pending→granted',
        'pending→declined',
        'pending→withdrawn',
        'granted→revoked',
        // A speaker may yield the floor themself.
        'granted→withdrawn',
      ].sort(),
    );
  });

  it('treats declined, revoked and withdrawn as terminal', () => {
    for (const state of TERMINAL_STATES) {
      expect(ALL.filter((to) => canTransition(state, to))).toEqual([]);
      expect(isOpen(request('x', state))).toBe(false);
    }
    expect(isOpen(request('x', 'pending'))).toBe(true);
    expect(isOpen(request('x', 'granted'))).toBe(true);
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

  it('returns null rather than corrupting state on an illegal transition', () => {
    const original = request('1', 'pending');
    expect(transition(original, 'revoked', at(5), 'teacher-1')).toBeNull();
    expect(original.state).toBe('pending');
  });

  it('defines repeats in one place: the target state is unchanged, a move outside the table is invalid', () => {
    expect(judgeTransition('granted', 'granted')).toBe('unchanged');
    expect(judgeTransition('declined', 'declined')).toBe('unchanged');
    expect(judgeTransition('pending', 'granted')).toBe('apply');
    expect(judgeTransition('declined', 'granted')).toBe('invalid');
    expect(judgeTransition('revoked', 'withdrawn')).toBe('invalid');
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
  });

  it('caps concurrent speakers at a technical limit (Q4)', () => {
    expect(MAX_CONCURRENT_SPEAKERS).toBe(4);
  });
});

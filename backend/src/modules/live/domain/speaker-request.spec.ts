import { asId } from '../../../shared';
import {
  MAX_CONCURRENT_SPEAKERS,
  canTransition,
  currentSpeakers,
  hasOpenRequest,
  pendingQueue,
  speakerSlotsAvailable,
  transition,
  type SpeakerRequest,
  type SpeakerRequestState,
} from './speaker-request';

const request = (
  id: string,
  userId: string,
  state: SpeakerRequestState,
  requestedAtMs: number,
): SpeakerRequest => ({
  id: asId<'SpeakerRequest'>(id),
  sessionId: 'session-1',
  userId,
  displayName: userId,
  state,
  requestedAt: new Date(requestedAtMs),
  decidedAt: null,
  decidedBy: null,
});

describe('the raise-hand queue', () => {
  it('orders pending hands oldest first regardless of insertion order', () => {
    const queue = pendingQueue([
      request('c', 'u3', 'pending', 300),
      request('a', 'u1', 'pending', 100),
      request('b', 'u2', 'pending', 200),
    ]);
    expect(queue.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('excludes decided hands from the queue', () => {
    const queue = pendingQueue([
      request('a', 'u1', 'granted', 100),
      request('b', 'u2', 'withdrawn', 200),
      request('c', 'u3', 'pending', 300),
    ]);
    expect(queue.map((r) => r.id)).toEqual(['c']);
  });

  it('treats a pending or granted hand as already open for that user', () => {
    const existing = [request('a', 'u1', 'pending', 1), request('b', 'u2', 'granted', 2)];
    expect(hasOpenRequest(existing, 'u1')).toBe(true);
    expect(hasOpenRequest(existing, 'u2')).toBe(true);
    expect(hasOpenRequest(existing, 'u3')).toBe(false);
  });

  it('does not treat a terminated hand as open, so a user may raise again', () => {
    const existing = [request('a', 'u1', 'revoked', 1), request('b', 'u1', 'withdrawn', 2)];
    expect(hasOpenRequest(existing, 'u1')).toBe(false);
  });

  it('counts only granted hands as current speakers', () => {
    const all = [
      request('a', 'u1', 'granted', 1),
      request('b', 'u2', 'pending', 2),
      request('c', 'u3', 'revoked', 3),
    ];
    expect(currentSpeakers(all).map((r) => r.userId)).toEqual(['u1']);
  });

  it('reports slots full once the concurrent speaker limit is reached', () => {
    const granted = Array.from({ length: MAX_CONCURRENT_SPEAKERS }, (_, i) =>
      request(`g${i}`, `u${i}`, 'granted', i),
    );
    expect(speakerSlotsAvailable(granted)).toBe(false);
    expect(speakerSlotsAvailable(granted.slice(1))).toBe(true);
  });
});

describe('speaker request transitions', () => {
  it('allows the legal moves out of pending', () => {
    expect(canTransition('pending', 'granted')).toBe(true);
    expect(canTransition('pending', 'declined')).toBe(true);
    expect(canTransition('pending', 'withdrawn')).toBe(true);
  });

  it('only allows a granted hand to be revoked', () => {
    expect(canTransition('granted', 'revoked')).toBe(true);
    expect(canTransition('granted', 'granted')).toBe(false);
    expect(canTransition('granted', 'declined')).toBe(false);
  });

  it('treats terminal states as terminal', () => {
    for (const state of ['revoked', 'withdrawn', 'declined'] as const) {
      expect(canTransition(state, 'granted')).toBe(false);
    }
  });

  it('records who decided and when on a legal transition', () => {
    const at = new Date(1_700_000_000_000);
    const result = transition(request('a', 'u1', 'pending', 1), 'granted', at, 'teacher-1');
    expect(result).not.toBeNull();
    expect(result?.state).toBe('granted');
    expect(result?.decidedBy).toBe('teacher-1');
    expect(result?.decidedAt).toEqual(at);
  });

  it('returns null rather than corrupting state on an illegal transition', () => {
    expect(transition(request('a', 'u1', 'revoked', 1), 'granted', new Date(), 't')).toBeNull();
  });
});

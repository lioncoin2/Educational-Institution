import { asId, type Clock } from '../../../shared';
import { newLiveSession, type LiveSession } from '../domain/live-session';
import type { LiveSessionRepository } from '../domain/ports';
import type {
  RtcCapabilities,
  RtcParticipantObservation,
  RtcParticipantObserver,
} from '../domain/rtc-provider';
import { LivePresenceService } from './live-presence.service';
import type { LiveSettings } from './live-settings';

const CAPS: RtcCapabilities = {
  canPublishAudio: false,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
};

function participant(
  identity: string,
  state: RtcParticipantObservation['state'] = 'active',
): RtcParticipantObservation {
  return {
    identity,
    state,
    standard: true,
    joinedAt: new Date(0),
    publishing: [],
    capabilities: CAPS,
  };
}

function liveSession(): LiveSession {
  return newLiveSession({
    id: asId<'LiveSession'>('s-live'),
    communityId: 'c-1',
    hostUserId: 'host-1',
    at: new Date('2026-01-01T00:00:00.000Z'),
    participantCap: 300,
    moderatorReserve: 10,
  });
}

function ended(session: LiveSession): LiveSession {
  return { ...session, state: 'ended', endedAt: new Date(1), endReason: 'moderator', endedBy: 'm' };
}

/** A repository that answers `findById` from a mutable map; the rest is never called here. */
class FakeSessions implements LiveSessionRepository {
  private readonly byId = new Map<string, LiveSession>();

  set(session: LiveSession): void {
    this.byId.set(session.id, session);
  }

  findById(id: string): Promise<LiveSession | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  findLiveByCommunity(): never {
    throw new Error('LivePresenceService never calls findLiveByCommunity');
  }
  start(): never {
    throw new Error('unused');
  }
  end(): never {
    throw new Error('unused');
  }
  listLive(): never {
    throw new Error('unused');
  }
  markEmpty(): never {
    throw new Error('unused');
  }
  noteViolation(): never {
    throw new Error('unused');
  }
  bumpEpoch(): never {
    throw new Error('unused');
  }
}

class FakeObserver implements RtcParticipantObserver {
  readonly rooms: string[] = [];
  impl: (room: string) => Promise<readonly RtcParticipantObservation[]> = () => Promise.resolve([]);

  listParticipants(roomName: string): Promise<readonly RtcParticipantObservation[]> {
    this.rooms.push(roomName);
    return this.impl(roomName);
  }

  getParticipant(): never {
    throw new Error('LivePresenceService never calls getParticipant');
  }
}

/** A clock that advances 1 s on each read, so observationStartedAt < observedAt. */
class SteppingClock implements Clock {
  private ms = 1_000;
  now(): Date {
    const at = new Date(this.ms);
    this.ms += 1_000;
    return at;
  }
}

const SETTINGS: LiveSettings = {
  roomNamePrefix: 'live-',
  participantCap: 300,
  moderatorReserve: 10,
  joinTokenTtlSeconds: 120,
};

function defer<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const settle = async (): Promise<void> => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe('LivePresenceService (attendance.md §5.3, live.md §13)', () => {
  let sessions: FakeSessions;
  let observer: FakeObserver;
  let service: LivePresenceService;

  beforeEach(() => {
    sessions = new FakeSessions();
    observer = new FakeObserver();
    service = new LivePresenceService(sessions, observer, SETTINGS, new SteppingClock());
  });

  it('answers not_found for an unknown session, without calling the provider', async () => {
    expect(await service.observe('nope')).toEqual({ kind: 'not_found' });
    expect(observer.rooms).toEqual([]);
  });

  it('answers not_active for a session that is not live, without calling the provider', async () => {
    sessions.set(ended(liveSession()));
    expect(await service.observe('s-live')).toEqual({ kind: 'not_active' });
    expect(observer.rooms).toEqual([]);
  });

  it('observes a live session: exactly one read of the right room, normalized, with the bracket', async () => {
    sessions.set(liveSession());
    observer.impl = () =>
      Promise.resolve([participant('user-2', 'joining'), participant('user-1', 'active')]);

    const result = await service.observe('s-live');

    expect(result).toEqual({
      kind: 'observed',
      liveSessionId: 's-live',
      communityId: 'c-1',
      observationStartedAt: new Date(1_000),
      observedAt: new Date(2_000),
      participants: [
        { userId: 'user-1', connection: 'connected' },
        { userId: 'user-2', connection: 'connecting' },
      ],
    });
    // Exactly one provider read, of the derived room name (epoch 0 → no suffix).
    expect(observer.rooms).toEqual(['live-s-live']);
  });

  it('discards the listing when the session ended during the observation → not_active', async () => {
    const live = liveSession();
    sessions.set(live);
    // The session ends between the first read and the re-check.
    observer.impl = () => {
      sessions.set(ended(live));
      return Promise.resolve([participant('user-1')]);
    };
    expect(await service.observe('s-live')).toEqual({ kind: 'not_active' });
    expect(observer.rooms).toEqual(['live-s-live']);
  });

  it('answers unavailable when the provider errors', async () => {
    sessions.set(liveSession());
    observer.impl = () => Promise.reject(new Error('provider down'));
    expect(await service.observe('s-live')).toEqual({ kind: 'unavailable' });
  });

  it('answers unavailable when the provider exceeds the 15 s deadline', async () => {
    jest.useFakeTimers();
    try {
      sessions.set(liveSession());
      observer.impl = () => new Promise<readonly RtcParticipantObservation[]>(() => {});
      const pending = service.observe('s-live');
      await jest.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toEqual({ kind: 'unavailable' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers unavailable when the listing exceeds 10,000 entries', async () => {
    sessions.set(liveSession());
    observer.impl = () =>
      Promise.resolve(Array.from({ length: 10_001 }, (_, i) => participant(`u-${i}`)));
    expect(await service.observe('s-live')).toEqual({ kind: 'unavailable' });
  });

  it('caps listings in flight at 4 per process — a fifth waits for a slot', async () => {
    sessions.set(liveSession());
    const deferreds: Array<{
      promise: Promise<readonly RtcParticipantObservation[]>;
      resolve: (v: readonly RtcParticipantObservation[]) => void;
    }> = [];
    observer.impl = () => {
      const d = defer<readonly RtcParticipantObservation[]>();
      deferreds.push(d);
      return d.promise;
    };

    const inFlight = Array.from({ length: 5 }, () => service.observe('s-live'));
    await settle();
    // Only four provider reads start; the fifth is blocked acquiring a slot.
    expect(observer.rooms.length).toBe(4);

    deferreds[0]?.resolve([]);
    await settle();
    expect(observer.rooms.length).toBe(5);

    // Release the rest so no observation is left hanging.
    for (const d of deferreds) d.resolve([]);
    await Promise.all(inFlight);
  });

  it('never caches — each observe is a fresh provider read', async () => {
    sessions.set(liveSession());
    observer.impl = () => Promise.resolve([]);
    await service.observe('s-live');
    await service.observe('s-live');
    expect(observer.rooms).toEqual(['live-s-live', 'live-s-live']);
  });
});

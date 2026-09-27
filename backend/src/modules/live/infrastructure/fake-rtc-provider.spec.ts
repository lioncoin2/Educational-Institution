import { AdjustableClock } from '../../../../test/support/identity-harness';
import {
  RtcUnavailableError,
  type RtcCapabilities,
  type RtcRoomSpec,
} from '../domain/rtc-provider';
import {
  FAKE_RTC_LOG_LIMIT,
  FAKE_TOKEN_PATTERN,
  FakeRtcProvider,
  RTC_OPERATIONS,
  type RtcOperation,
} from './fake-rtc-provider';

const LISTENER: RtcCapabilities = {
  canPublishAudio: false,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
};
const SPEAKER: RtcCapabilities = { ...LISTENER, canPublishAudio: true };
const PRESENTER: RtcCapabilities = { ...SPEAKER, canPublishScreen: true };

const spec = (roomName: string, maxParticipants = 310): RtcRoomSpec => ({
  roomName,
  maxParticipants,
  emptyTimeoutSeconds: 1_200,
  departureTimeoutSeconds: 1_200,
});

const START = new Date('2026-09-27T10:00:00.000Z');

function fake() {
  const clock = new AdjustableClock(START);
  return { clock, rtc: new FakeRtcProvider(clock) };
}

/** One call of each operation, with harmless arguments. */
const CALL: Readonly<Record<RtcOperation, (rtc: FakeRtcProvider) => Promise<unknown>>> = {
  ensureRoom: (rtc) => rtc.ensureRoom(spec('room-a')),
  endRoom: (rtc) => rtc.endRoom('room-a'),
  listRooms: (rtc) => rtc.listRooms(),
  issueAccessToken: (rtc) =>
    rtc.issueAccessToken({
      roomName: 'room-a',
      identity: 'u',
      displayName: '',
      capabilities: LISTENER,
      ttlSeconds: 120,
    }),
  updateCapabilities: (rtc) => rtc.updateCapabilities('room-a', 'u', LISTENER),
  removeParticipant: (rtc) => rtc.removeParticipant('room-a', 'u'),
  muteParticipant: (rtc) => rtc.muteParticipant('room-a', 'u', ['microphone']),
  listParticipants: (rtc) => rtc.listParticipants('room-a'),
  getParticipant: (rtc) => rtc.getParticipant('room-a', 'u'),
};

describe('the fake RTC provider — rooms', () => {
  it('creates a room once, dated by the injected clock, and updates it in place after', async () => {
    const { clock, rtc } = fake();
    await rtc.ensureRoom(spec('room-a', 310));
    clock.advance(30);
    await rtc.ensureRoom(spec('room-a', 500));
    expect(rtc.room('room-a')).toEqual({ spec: spec('room-a', 500), createdAt: START });
    expect(rtc.roomNames()).toEqual(['room-a']);
    expect(await rtc.listRooms()).toEqual([
      { roomName: 'room-a', participantCount: 0, createdAt: START },
    ]);
    expect(rtc.ensured).toEqual([spec('room-a', 310), spec('room-a', 500)]);
  });

  it('ends a room — and everyone in it — and treats ending a missing room as done', async () => {
    const { rtc } = fake();
    await rtc.ensureRoom(spec('room-a'));
    rtc.connect('room-a', 'student-1', LISTENER);
    await rtc.endRoom('room-a');
    await expect(rtc.endRoom('room-a')).resolves.toBeUndefined();
    await expect(rtc.endRoom('never-existed')).resolves.toBeUndefined();
    expect(rtc.roomNames()).toEqual([]);
    expect(rtc.observed('room-a')).toEqual([]);
    expect(rtc.ended).toEqual(['room-a', 'room-a', 'never-existed']);
  });

  it('lists current rooms only — all of them, or those named — counting who is observed in each', async () => {
    const { clock, rtc } = fake();
    await rtc.ensureRoom(spec('room-a'));
    clock.advance(5);
    await rtc.ensureRoom(spec('room-b'));
    await rtc.ensureRoom(spec('room-c'));
    await rtc.endRoom('room-c');
    rtc.connect('room-b', 'student-1', LISTENER);
    rtc.connect('room-b', 'student-2', LISTENER);
    expect(await rtc.listRooms()).toEqual([
      { roomName: 'room-a', participantCount: 0, createdAt: START },
      { roomName: 'room-b', participantCount: 2, createdAt: new Date(START.getTime() + 5_000) },
    ]);
    expect((await rtc.listRooms(['room-b', 'room-c'])).map((room) => room.roomName)).toEqual([
      'room-b',
    ]);
  });
});

describe('the fake RTC provider — participants', () => {
  it('applies a capability set to someone in the room, and unpublishes what it no longer allows', async () => {
    const { rtc } = fake();
    rtc.connect('room-a', 'student-1', PRESENTER, ['microphone', 'screen_share']);
    expect(await rtc.updateCapabilities('room-a', 'student-1', SPEAKER)).toBe('applied');
    expect(await rtc.getParticipant('room-a', 'student-1')).toMatchObject({
      identity: 'student-1',
      state: 'active',
      standard: true,
      joinedAt: START,
      capabilities: SPEAKER,
      publishing: ['microphone'],
    });
    expect(rtc.capabilityChanges).toEqual([
      { roomName: 'room-a', identity: 'student-1', capabilities: SPEAKER },
    ]);
  });

  it('answers not_connected for someone who is not in the room, and records nothing', async () => {
    const { rtc } = fake();
    rtc.connect('room-a', 'student-1', LISTENER);
    rtc.disconnect('room-a', 'student-1');
    expect(await rtc.updateCapabilities('room-a', 'student-1', SPEAKER)).toBe('not_connected');
    expect(await rtc.updateCapabilities('room-b', 'student-1', SPEAKER)).toBe('not_connected');
    expect(await rtc.removeParticipant('room-a', 'student-1')).toBe('not_connected');
    expect(await rtc.muteParticipant('room-a', 'student-1', ['microphone'])).toBe('not_connected');
    expect(await rtc.getParticipant('room-a', 'student-1')).toBeNull();
    expect(rtc.capabilityChanges).toEqual([]);
    expect(rtc.removed).toEqual([]);
    expect(rtc.muted).toEqual([]);
  });

  it('removes someone from what it observes, recording the options the removal carried', async () => {
    const { clock, rtc } = fake();
    rtc.connect('room-a', 'student-1', SPEAKER, ['microphone']);
    rtc.connect('room-a', 'student-2', LISTENER);
    expect(
      await rtc.removeParticipant('room-a', 'student-1', { revokeTokensIssuedBefore: clock.now() }),
    ).toBe('applied');
    expect(await rtc.removeParticipant('room-a', 'student-2')).toBe('applied');
    expect(await rtc.listParticipants('room-a')).toEqual([]);
    expect(rtc.removed).toEqual([
      { roomName: 'room-a', identity: 'student-1', revokeTokensIssuedBefore: START },
      { roomName: 'room-a', identity: 'student-2', revokeTokensIssuedBefore: null },
    ]);
  });

  it('mutes the named sources of someone publishing them', async () => {
    const { rtc } = fake();
    rtc.connect('room-a', 'teacher-1', PRESENTER, ['microphone', 'screen_share']);
    expect(await rtc.muteParticipant('room-a', 'teacher-1', ['microphone'])).toBe('applied');
    expect(rtc.observed('room-a')[0]?.publishing).toEqual(['screen_share']);
    expect(rtc.muted).toEqual([
      { roomName: 'room-a', identity: 'teacher-1', sources: ['microphone'] },
    ]);
  });

  it('observes what a test scripts, one entry per identity', async () => {
    const { rtc } = fake();
    const observation = {
      identity: 'egress-1',
      state: 'joined' as const,
      standard: false,
      joinedAt: START,
      publishing: [],
      capabilities: LISTENER,
    };
    rtc.observe('room-a', [observation, { ...observation, identity: 'student-1', standard: true }]);
    expect((await rtc.listParticipants('room-a')).map((p) => p.identity)).toEqual([
      'egress-1',
      'student-1',
    ]);
    rtc.observe('room-a', []);
    expect(await rtc.listParticipants('room-a')).toEqual([]);
  });
});

describe('the fake RTC provider — tokens', () => {
  it('issues deterministic, obviously fake tokens — never a JWT — and records the grant', async () => {
    const { rtc } = fake();
    const grant = {
      roomName: 'live-room.2',
      identity: 'student-1',
      displayName: 'مريم',
      capabilities: LISTENER,
      ttlSeconds: 120,
    };
    const listener = await rtc.issueAccessToken(grant);
    const speaker = await rtc.issueAccessToken({ ...grant, capabilities: SPEAKER });
    expect(listener).toEqual({
      token: 'fake.live-room.2.student-1.sub',
      url: 'ws://fake-rtc.local',
      expiresInSeconds: 120,
    });
    expect(speaker.token).toBe('fake.live-room.2.student-1.pub');
    for (const token of [listener.token, speaker.token]) {
      expect(token).toMatch(FAKE_TOKEN_PATTERN);
      expect(token).not.toMatch(/^eyJ/);
    }
    expect(rtc.issued).toEqual([grant, { ...grant, capabilities: SPEAKER }]);
  });
});

describe('the fake RTC provider — failures, gates and logs', () => {
  it.each(RTC_OPERATIONS)('fails the next %s as an outage, once', async (operation) => {
    const { rtc } = fake();
    rtc.failNext(operation, 'unavailable');
    await expect(CALL[operation](rtc)).rejects.toBeInstanceOf(RtcUnavailableError);
    // Used up: the next call goes through.
    await CALL[operation](rtc);
  });

  it.each(RTC_OPERATIONS)(
    'fails the next %s as a fault — never mistaken for an outage',
    async (operation) => {
      const { rtc } = fake();
      rtc.failNext(operation, 'fault');
      const failed = CALL[operation](rtc);
      await expect(failed).rejects.toThrow(`refused ${operation}`);
      await expect(failed).rejects.not.toBeInstanceOf(RtcUnavailableError);
    },
  );

  it('uses scripted failures up in order, one per call, leaving other operations alone', async () => {
    const { rtc } = fake();
    rtc.failNext('ensureRoom', 'fault');
    rtc.failNext('ensureRoom', 'unavailable');
    await expect(rtc.listRooms()).resolves.toEqual([]);
    await expect(rtc.ensureRoom(spec('room-a'))).rejects.not.toBeInstanceOf(RtcUnavailableError);
    await expect(rtc.ensureRoom(spec('room-a'))).rejects.toBeInstanceOf(RtcUnavailableError);
    await expect(rtc.ensureRoom(spec('room-a'))).resolves.toBeUndefined();
    // A failed call took no effect.
    expect(rtc.ensured).toEqual([spec('room-a')]);
  });

  it('fails every call while unavailable — token signing included — until cleared', async () => {
    const { rtc } = fake();
    rtc.setUnavailable(true);
    for (const operation of RTC_OPERATIONS) {
      await expect(CALL[operation](rtc)).rejects.toBeInstanceOf(RtcUnavailableError);
    }
    expect(rtc.issued).toEqual([]);
    rtc.setUnavailable(false);
    for (const operation of RTC_OPERATIONS) await CALL[operation](rtc);
    expect(rtc.issued).toHaveLength(1);
  });

  it('holds an operation’s calls at a gate until released, and says when one arrives', async () => {
    const { rtc } = fake();
    const gate = rtc.hold('ensureRoom');
    let done = false;
    const ensuring = rtc.ensureRoom(spec('room-a')).then(() => {
      done = true;
    });
    await gate.reached;
    // Other operations pass; the held call has not taken effect.
    await rtc.listRooms();
    expect(rtc.room('room-a')).toBeNull();
    expect(done).toBe(false);
    // A failure scripted while it waits applies when it goes on.
    rtc.failNext('ensureRoom', 'unavailable');
    gate.release();
    await expect(ensuring).rejects.toBeInstanceOf(RtcUnavailableError);
    // Released: later calls pass straight through.
    await rtc.ensureRoom(spec('room-a'));
    expect(rtc.room('room-a')).not.toBeNull();
    expect(() => rtc.hold('ensureRoom')).not.toThrow();
  });

  it('holds one gate per operation at a time', () => {
    const { rtc } = fake();
    rtc.hold('endRoom');
    expect(() => rtc.hold('endRoom')).toThrow('already held');
  });

  it('logs every call when it arrives, reads and failed calls included', async () => {
    const { clock, rtc } = fake();
    await rtc.ensureRoom(spec('room-a'));
    clock.advance(1);
    await rtc.listRooms(['room-a']);
    await rtc.listRooms();
    await rtc.getParticipant('room-a', 'student-1');
    rtc.failNext('listParticipants', 'unavailable');
    await expect(rtc.listParticipants('room-a')).rejects.toBeInstanceOf(RtcUnavailableError);
    const later = new Date(START.getTime() + 1_000);
    expect(rtc.calls).toEqual([
      { operation: 'ensureRoom', roomName: 'room-a', at: START },
      { operation: 'listRooms', roomNames: ['room-a'], at: later },
      { operation: 'listRooms', at: later },
      { operation: 'getParticipant', roomName: 'room-a', identity: 'student-1', at: later },
      { operation: 'listParticipants', roomName: 'room-a', at: later },
    ]);
  });

  it('keeps each log to its newest entries', async () => {
    const { rtc } = fake();
    for (let n = 0; n < FAKE_RTC_LOG_LIMIT + 5; n += 1) {
      await rtc.issueAccessToken({
        roomName: 'room-a',
        identity: `user-${n}`,
        displayName: '',
        capabilities: LISTENER,
        ttlSeconds: 120,
      });
    }
    expect(rtc.issued).toHaveLength(FAKE_RTC_LOG_LIMIT);
    expect(rtc.calls).toHaveLength(FAKE_RTC_LOG_LIMIT);
    expect(rtc.issued[0]?.identity).toBe('user-5');
    expect(rtc.issued.at(-1)?.identity).toBe(`user-${FAKE_RTC_LOG_LIMIT + 4}`);
  });
});

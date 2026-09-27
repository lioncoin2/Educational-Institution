import { asId } from '../../../shared';
import {
  currentMediaRoom,
  durationSeconds,
  endSession,
  isLive,
  isMediaRoomName,
  liveSessionOrder,
  mediaRoomName,
  newLiveSession,
  parseMediaRoomName,
  type LiveSession,
} from './live-session';

const ID = '3f0c2a4e-8b1d-4c6a-9e2f-5a7b9c1d3e5f';
const OTHER = 'b7e6d5c4-a3b2-4c1d-8e9f-0a1b2c3d4e5f';
const START = new Date('2026-09-27T10:00:00.000Z');

const session = (overrides: Partial<LiveSession> = {}): LiveSession => ({
  ...newLiveSession({
    id: asId<'LiveSession'>(ID),
    communityId: 'community-1',
    hostUserId: 'teacher-1',
    at: START,
    participantCap: 300,
    moderatorReserve: 10,
  }),
  ...overrides,
});

describe('a new live session', () => {
  it('starts live, at state version 1, on media room epoch 0, with nothing ended or observed', () => {
    expect(session()).toEqual({
      id: ID,
      communityId: 'community-1',
      hostUserId: 'teacher-1',
      state: 'live',
      stateVersion: 1,
      startedAt: START,
      endedAt: null,
      endedBy: null,
      endReason: null,
      participantCap: 300,
      moderatorReserve: 10,
      mediaRoomEpoch: 0,
      emptySince: null,
      enforcementViolations: 0,
      lastViolationAt: null,
    });
    expect(isLive(session())).toBe(true);
  });

  it('refuses the bounds its table’s CHECKs refuse: a cap below 1, a negative or fractional reserve', () => {
    const make = (participantCap: number, moderatorReserve: number) => () =>
      newLiveSession({
        id: asId<'LiveSession'>(ID),
        communityId: 'c',
        hostUserId: 'h',
        at: START,
        participantCap,
        moderatorReserve,
      });
    expect(make(0, 10)).toThrow(RangeError);
    expect(make(2.5, 10)).toThrow(RangeError);
    expect(make(300, -1)).toThrow(RangeError);
    expect(make(300, 0.5)).toThrow(RangeError);
    expect(make(1, 0)).not.toThrow();
  });
});

describe('ending a session', () => {
  const ENDED = new Date('2026-09-27T10:30:15.900Z');

  it('ends it one state version later, saying when, by whom and why', () => {
    const ended = endSession(session({ stateVersion: 7 }), {
      at: ENDED,
      endedBy: 'teacher-1',
      reason: 'moderator',
    });
    expect(ended).toMatchObject({
      state: 'ended',
      stateVersion: 8,
      endedAt: ENDED,
      endedBy: 'teacher-1',
      endReason: 'moderator',
    });
    expect(isLive(ended)).toBe(false);
    expect(durationSeconds(ended)).toBe(30 * 60 + 15);
    expect(durationSeconds(session())).toBeNull();
  });

  it('lets the system end it with no actor, but never a moderator’s end without one (S2)', () => {
    expect(endSession(session(), { at: ENDED, endedBy: null, reason: 'idle' })).toMatchObject({
      endedBy: null,
      endReason: 'idle',
    });
    expect(
      endSession(session(), { at: ENDED, endedBy: null, reason: 'community_closed' }).endReason,
    ).toBe('community_closed');
    expect(() => endSession(session(), { at: ENDED, endedBy: null, reason: 'moderator' })).toThrow(
      RangeError,
    );
  });

  it('ends only once: `ended` is terminal (S3)', () => {
    const ended = endSession(session(), { at: ENDED, endedBy: 'teacher-1', reason: 'moderator' });
    expect(() => endSession(ended, { at: ENDED, endedBy: 'x', reason: 'moderator' })).toThrow(
      RangeError,
    );
  });
});

describe('the media room’s name', () => {
  it('is the prefix and the session id on epoch 0, with `.epoch` after a reset', () => {
    expect(mediaRoomName('live-', ID, 0)).toBe(`live-${ID}`);
    expect(mediaRoomName('live-', ID, 1)).toBe(`live-${ID}.1`);
    expect(mediaRoomName('live-prod-', ID, 12)).toBe(`live-prod-${ID}.12`);
    expect(currentMediaRoom('live-', session({ mediaRoomEpoch: 3 }))).toBe(`live-${ID}.3`);
  });

  it('refuses an empty prefix and an epoch that is not a whole number, 0 or more', () => {
    expect(() => mediaRoomName('', ID, 0)).toThrow(RangeError);
    expect(() => mediaRoomName('live-', ID, -1)).toThrow(RangeError);
    expect(() => mediaRoomName('live-', ID, 1.5)).toThrow(RangeError);
    expect(() => isMediaRoomName('', ID)).toThrow(RangeError);
  });

  it('is recognized, with its session and epoch, for epoch 0 and epoch n', () => {
    for (const epoch of [0, 1, 2, 9, 10, 1234]) {
      const name = mediaRoomName('live-', ID, epoch);
      expect(isMediaRoomName('live-', name)).toBe(true);
      expect(parseMediaRoomName('live-', name)).toEqual({ sessionId: ID, epoch });
    }
  });

  it('is never another deployment’s: a prefix that merely starts with ours is not ours', () => {
    const theirs = mediaRoomName('live-prod-', OTHER, 0);
    expect(isMediaRoomName('live-', theirs)).toBe(false);
    expect(isMediaRoomName('live-', mediaRoomName('live-prod-', OTHER, 4))).toBe(false);
    expect(isMediaRoomName('live-', `live-a${ID}`)).toBe(false);
    // …and the other way round: our rooms are not theirs either.
    expect(isMediaRoomName('live-prod-', mediaRoomName('live-', ID, 0))).toBe(false);
    expect(isMediaRoomName('live-prod-', theirs)).toBe(true);
  });

  it('matches the prefix as text, never as a pattern', () => {
    // `.` is legal in a prefix; as a pattern it would match any character.
    expect(isMediaRoomName('live.', `live.${ID}`)).toBe(true);
    expect(isMediaRoomName('live.', `liveX${ID}`)).toBe(false);
    expect(isMediaRoomName('a.b', `aXb${ID}`)).toBe(false);
  });

  it('accepts only the exact form: prefix, a lower-case uuid, and a positive epoch with no leading zero', () => {
    for (const name of [
      `live-${ID}.0`,
      `live-${ID}.01`,
      `live-${ID}.-1`,
      `live-${ID}.1.2`,
      `live-${ID}.`,
      `live-${ID}.1x`,
      `live-${ID}x`,
      `live-${ID} `,
      ` live-${ID}`,
      `xlive-${ID}`,
      `live-${ID.toUpperCase()}`,
      `live-${ID.slice(0, 35)}`,
      `live-${ID.replace(/-/g, '')}`,
      'live-session-1',
      'live-',
      `live-${ID}.99999999999999999999`,
    ]) {
      expect({ name, ours: isMediaRoomName('live-', name) }).toEqual({ name, ours: false });
    }
  });
});

describe('the live sessions’ page order', () => {
  it('is (startedAt, id) ascending, so equal instants never reorder', () => {
    const keys = [
      { startedAt: new Date(20), id: 'a' },
      { startedAt: new Date(10), id: 'c' },
      { startedAt: new Date(10), id: 'b' },
    ];
    expect([...keys].sort(liveSessionOrder).map((key) => key.id)).toEqual(['b', 'c', 'a']);
  });
});

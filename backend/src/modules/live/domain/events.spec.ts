import { asId } from '../../../shared';
import { LiveEvents } from '../contracts/events';
import {
  liveSessionEnded,
  liveSessionStarted,
  screenShareStarted,
  screenShareStopped,
  speakerDeclined,
  speakerExpired,
  speakerGranted,
  speakerRequested,
  speakerRevoked,
  speakerWithdrawn,
} from './events';
import { endSession, newLiveSession } from './live-session';
import { closePresenterGrant, newPresenterGrant } from './presenter-grant';
import { newSpeakerRequest, transition, type SpeakerRequest } from './speaker-request';

const T = (seconds: number) => new Date(Date.UTC(2026, 8, 27, 10, 0, seconds));

const session = newLiveSession({
  id: asId<'LiveSession'>('session-1'),
  communityId: 'community-1',
  hostUserId: 'teacher-1',
  at: T(0),
  participantCap: 300,
  moderatorReserve: 10,
});

const pending = newSpeakerRequest({
  id: asId<'SpeakerRequest'>('request-1'),
  sessionId: session.id,
  userId: 'student-1',
  at: T(5),
});

const moved = (request: SpeakerRequest, to: SpeakerRequest['state'], at: Date, by: string | null) =>
  transition(request, to, at, by) as SpeakerRequest;

const SPEAKER_FIELDS = ['communityId', 'requestId', 'sessionId', 'stateVersion', 'userId'];

describe('live events', () => {
  it('announce a start with ids only, on the session’s stream', () => {
    const event = liveSessionStarted(session, 'corr-1');
    expect(event).toEqual({
      name: LiveEvents.sessionStarted,
      aggregateId: 'session-1',
      occurredAt: T(0),
      payload: { sessionId: 'session-1', communityId: 'community-1', hostUserId: 'teacher-1' },
      correlationId: 'corr-1',
    });
  });

  it('announce an end once, with who, why and how long — the system as a null actor', () => {
    const ended = endSession(session, { at: T(95), endedBy: 'teacher-1', reason: 'moderator' });
    expect(liveSessionEnded(ended)).toMatchObject({
      name: 'live.session.ended',
      aggregateId: 'session-1',
      occurredAt: T(95),
      payload: {
        sessionId: 'session-1',
        communityId: 'community-1',
        endedBy: 'teacher-1',
        reason: 'moderator',
        durationSeconds: 95,
      },
    });
    const idle = endSession(session, { at: T(30), endedBy: null, reason: 'idle' });
    expect(liveSessionEnded(idle).payload).toMatchObject({ endedBy: null, reason: 'idle' });
    expect(() => liveSessionEnded(session)).toThrow(RangeError);
  });

  it('carry the request, its owner, the community and the new state version on every speaker event', () => {
    const granted = moved(pending, 'granted', T(10), 'teacher-1');
    const events = [
      speakerRequested(session, pending, 2),
      speakerGranted(session, granted, 3),
      speakerDeclined(session, moved(pending, 'declined', T(11), 'teacher-2'), 3),
      speakerRevoked(session, moved(granted, 'revoked', T(12), 'teacher-2'), 4),
      speakerWithdrawn(session, moved(pending, 'withdrawn', T(13), 'student-1'), 3),
      speakerExpired(session, moved(granted, 'expired', T(14), null), 4),
    ];
    expect(events.map((event) => event.name)).toEqual([
      'live.speaker.requested',
      'live.speaker.granted',
      'live.speaker.declined',
      'live.speaker.revoked',
      'live.speaker.withdrawn',
      'live.speaker.expired',
    ]);
    for (const event of events) {
      expect(event.aggregateId).toBe('session-1');
      expect(event.payload).toMatchObject({
        sessionId: 'session-1',
        communityId: 'community-1',
        requestId: 'request-1',
        userId: 'student-1',
      });
    }
    expect(events.map((event) => Object.keys(event.payload).sort())).toEqual([
      SPEAKER_FIELDS,
      [...SPEAKER_FIELDS, 'grantedBy'].sort(),
      [...SPEAKER_FIELDS, 'declinedBy'].sort(),
      [...SPEAKER_FIELDS, 'revokedBy'].sort(),
      [...SPEAKER_FIELDS, 'from'].sort(),
      [...SPEAKER_FIELDS, 'cause', 'from'].sort(),
    ]);
  });

  it('say who decided, when, and which open state a withdrawal or an expiry closed', () => {
    const granted = moved(pending, 'granted', T(10), 'teacher-1');
    expect(speakerGranted(session, granted, 3)).toMatchObject({
      occurredAt: T(10),
      payload: { grantedBy: 'teacher-1', stateVersion: 3 },
    });
    expect(
      speakerDeclined(session, moved(pending, 'declined', T(11), 'teacher-2'), 3),
    ).toMatchObject({ occurredAt: T(11), payload: { declinedBy: 'teacher-2' } });
    expect(
      speakerRevoked(session, moved(granted, 'revoked', T(12), 'teacher-2'), 4).payload,
    ).toMatchObject({ revokedBy: 'teacher-2' });
    expect(
      speakerWithdrawn(session, moved(pending, 'withdrawn', T(13), 'student-1'), 3).payload,
    ).toMatchObject({ from: 'pending' });
    expect(
      speakerWithdrawn(session, moved(granted, 'withdrawn', T(13), 'student-1'), 4).payload,
    ).toMatchObject({ from: 'granted' });
    expect(speakerExpired(session, moved(pending, 'expired', T(14), null), 3)).toMatchObject({
      occurredAt: T(14),
      payload: { from: 'pending', cause: 'ineligible' },
    });
    expect(
      speakerExpired(session, moved(granted, 'expired', T(14), null), 4).payload,
    ).toMatchObject({
      from: 'granted',
      cause: 'ineligible',
    });
  });

  it('refuse to announce a decision the request does not carry', () => {
    expect(() => speakerGranted(session, pending, 2)).toThrow(RangeError);
    expect(() => speakerExpired(session, pending, 2)).toThrow(RangeError);
  });

  it('announce the presenter slot opening and closing — never for the end of the session', () => {
    const grant = newPresenterGrant({
      id: asId<'PresenterGrant'>('grant-1'),
      sessionId: session.id,
      userId: 'teacher-1',
      grantedBy: 'teacher-1',
      at: T(20),
    });
    expect(screenShareStarted(session, grant, 5)).toEqual({
      name: 'live.screen_share.started',
      aggregateId: 'session-1',
      occurredAt: T(20),
      payload: {
        sessionId: 'session-1',
        communityId: 'community-1',
        userId: 'teacher-1',
        grantedBy: 'teacher-1',
        stateVersion: 5,
      },
      correlationId: undefined,
    });
    const revoked = closePresenterGrant(grant, { at: T(40), by: 'teacher-2', reason: 'revoked' });
    expect(screenShareStopped(session, revoked, 6)).toMatchObject({
      name: 'live.screen_share.stopped',
      occurredAt: T(40),
      payload: {
        sessionId: 'session-1',
        communityId: 'community-1',
        userId: 'teacher-1',
        stoppedBy: 'teacher-2',
        reason: 'revoked',
        stateVersion: 6,
      },
    });
    const ineligible = closePresenterGrant(grant, { at: T(41), by: null, reason: 'ineligible' });
    expect(screenShareStopped(session, ineligible, 6).payload).toMatchObject({
      stoppedBy: null,
      reason: 'ineligible',
    });
    const byTheEnd = closePresenterGrant(grant, { at: T(42), by: null, reason: 'session_ended' });
    expect(() => screenShareStopped(session, byTheEnd, 7)).toThrow(RangeError);
    expect(() => screenShareStopped(session, grant, 7)).toThrow(RangeError);
  });

  it('carry ids, codes and versions only — nothing spread from an entity', () => {
    const ended = endSession(session, { at: T(95), endedBy: 'teacher-1', reason: 'moderator' });
    const payloadKeys = [
      liveSessionStarted(session),
      liveSessionEnded(ended),
      speakerRequested(session, pending, 2),
    ].map((event) => Object.keys(event.payload).sort());
    expect(payloadKeys).toEqual([
      ['communityId', 'hostUserId', 'sessionId'],
      ['communityId', 'durationSeconds', 'endedBy', 'reason', 'sessionId'],
      SPEAKER_FIELDS,
    ]);
  });
});

import { asId, err, failure, ok, type Principal, type Result } from '../../../shared';
import type { AuthorizationService } from '../../identity/contracts';
import type { LiveRoom, LiveSession } from '../domain/live-room';
import type { SpeakerRequest } from '../domain/speaker-request';
import { FakeRtcProvider } from '../infrastructure/fake-rtc-provider';
import {
  InMemoryLiveRoomRepository,
  InMemoryLiveSessionRepository,
  InMemorySpeakerRequestRepository,
} from '../infrastructure/in-memory-live-repositories';
import { JoinLiveSessionUseCase } from './join-live-session.use-case';

const allowAll: AuthorizationService = {
  can: () => true,
  authorize: () => ok(undefined),
  // The use case never resolves principals itself; the HTTP edge does.
  principalFor: (userId, roles) => ({ userId, roles, permissions: new Set<string>() }),
};

const denyAll: AuthorizationService = {
  can: () => false,
  authorize: () => err(failure('forbidden', 'denied', 'no')),
  // The use case never resolves principals itself; the HTTP edge does.
  principalFor: (userId, roles) => ({ userId, roles, permissions: new Set<string>() }),
};

const HOST = 'teacher-1';
const ROOM_ID = asId<'LiveRoom'>('room-1');
const SESSION_ID = asId<'LiveSession'>('session-1');

const room: LiveRoom = {
  id: ROOM_ID,
  halaqaId: 'halaqa-1',
  title: 'Tajweed',
  hostUserId: HOST,
  maxParticipants: 2500,
  createdAt: new Date(0),
};

const liveSession: LiveSession = {
  id: SESSION_ID,
  roomId: ROOM_ID,
  state: 'live',
  startedAt: new Date(0),
  endedAt: null,
};

const principal = (userId: string): Principal => ({
  userId,
  roles: [],
  permissions: new Set<string>(),
});

function build(options: {
  authorization?: AuthorizationService;
  session?: LiveSession;
  requests?: SpeakerRequest[];
}) {
  const rtc = new FakeRtcProvider();
  const requests = new InMemorySpeakerRequestRepository();
  const useCase = new JoinLiveSessionUseCase(
    options.authorization ?? allowAll,
    new InMemoryLiveSessionRepository([options.session ?? liveSession]),
    new InMemoryLiveRoomRepository([room]),
    requests,
    rtc,
  );
  return { useCase, rtc, requests };
}

const unwrapOk = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
};

describe('JoinLiveSessionUseCase', () => {
  it('refuses a caller without the join permission', async () => {
    const { useCase, rtc } = build({ authorization: denyAll });

    const result = await useCase.execute({
      principal: principal('student-1'),
      sessionId: SESSION_ID,
      displayName: 'Student',
    });

    expect(result.ok).toBe(false);
    // Nothing was minted: authorization is checked before any provider call.
    expect(rtc.issued).toHaveLength(0);
  });

  // The property the whole 2500-participant design rests on.
  it('issues a listener token that cannot publish audio', async () => {
    const { useCase, rtc } = build({});

    const token = unwrapOk(
      await useCase.execute({
        principal: principal('student-1'),
        sessionId: SESSION_ID,
        displayName: 'Student',
      }),
    );

    expect(rtc.issued).toHaveLength(1);
    expect(rtc.issued[0]?.capabilities.canPublishAudio).toBe(false);
    expect(rtc.issued[0]?.capabilities.canSubscribe).toBe(true);
    expect(token.token).toContain('sub');
  });

  it('issues a publishing token to the host', async () => {
    const { useCase, rtc } = build({});

    await useCase.execute({
      principal: principal(HOST),
      sessionId: SESSION_ID,
      displayName: 'Teacher',
    });

    expect(rtc.issued[0]?.capabilities.canPublishAudio).toBe(true);
  });

  // A granted speaker who drops off must come back able to speak, or every
  // reconnect would silently demote them.
  it('restores publishing rights to a participant holding a grant', async () => {
    const { useCase, rtc, requests } = build({});
    await requests.save({
      id: asId<'SpeakerRequest'>('req-1'),
      sessionId: SESSION_ID,
      userId: 'student-1',
      displayName: 'Student',
      state: 'granted',
      requestedAt: new Date(0),
      decidedAt: new Date(0),
      decidedBy: HOST,
    });

    await useCase.execute({
      principal: principal('student-1'),
      sessionId: SESSION_ID,
      displayName: 'Student',
    });

    expect(rtc.issued[0]?.capabilities.canPublishAudio).toBe(true);
  });

  it('does not restore rights from a revoked grant', async () => {
    const { useCase, rtc, requests } = build({});
    await requests.save({
      id: asId<'SpeakerRequest'>('req-1'),
      sessionId: SESSION_ID,
      userId: 'student-1',
      displayName: 'Student',
      state: 'revoked',
      requestedAt: new Date(0),
      decidedAt: new Date(0),
      decidedBy: HOST,
    });

    await useCase.execute({
      principal: principal('student-1'),
      sessionId: SESSION_ID,
      displayName: 'Student',
    });

    expect(rtc.issued[0]?.capabilities.canPublishAudio).toBe(false);
  });

  it('refuses to mint a token for a session that is not live', async () => {
    const { useCase, rtc } = build({
      session: { ...liveSession, state: 'ended', endedAt: new Date(1) },
    });

    const result = await useCase.execute({
      principal: principal('student-1'),
      sessionId: SESSION_ID,
      displayName: 'Student',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('live.session_not_live');
    expect(rtc.issued).toHaveLength(0);
  });

  it('reports a missing session as not found', async () => {
    const { useCase } = build({});
    const result = await useCase.execute({
      principal: principal('student-1'),
      sessionId: 'nope',
      displayName: 'Student',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
  });

  it('scopes the token to the session and the caller', async () => {
    const { useCase, rtc } = build({});
    await useCase.execute({
      principal: principal('student-9'),
      sessionId: SESSION_ID,
      displayName: 'Student',
    });
    expect(rtc.issued[0]?.roomName).toBe(SESSION_ID);
    expect(rtc.issued[0]?.identity).toBe('student-9');
  });
});

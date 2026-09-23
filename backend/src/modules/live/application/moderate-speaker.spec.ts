import {
  FixedClock,
  asId,
  err,
  failure,
  ok,
  type DomainEvent,
  type EventPublisher,
  type Id,
  type IdGenerator,
  type Principal,
} from '../../../shared';
import { RecordingAuditLog } from '../../../../test/support/identity-harness';
import type { AuthorizationService } from '../../identity/contracts';
// The real decision point, to test room scoping end to end. Test-only reach
// into identity's internals; production code sees only its contracts.
import { PolicyAuthorizationService } from '../../identity/application/authorization.service';
import {
  PROVISIONAL_POLICY_RULES,
  PROVISIONAL_ROLE_PERMISSIONS,
} from '../../identity/domain/provisional-policy';
import type { LiveRoom, LiveSession } from '../domain/live-room';
import { MAX_CONCURRENT_SPEAKERS, type SpeakerRequest } from '../domain/speaker-request';
import { FakeRtcProvider } from '../infrastructure/fake-rtc-provider';
import {
  InMemoryLiveRoomRepository,
  InMemoryLiveSessionRepository,
  InMemoryModerationLog,
  InMemorySpeakerRequestRepository,
} from '../infrastructure/in-memory-live-repositories';
import { ModerateSpeakerUseCase } from './moderate-speaker.use-case';

const allowAll: AuthorizationService = {
  can: () => true,
  authorize: () => ok(undefined),
};
const denyAll: AuthorizationService = {
  can: () => false,
  authorize: () => err(failure('forbidden', 'denied', 'no')),
};

class CountingIdGenerator implements IdGenerator {
  private n = 0;
  next<TBrand extends string>(): Id<TBrand> {
    this.n += 1;
    return asId<TBrand>(`generated-${this.n}`);
  }
}

class RecordingPublisher implements EventPublisher {
  readonly published: DomainEvent[] = [];
  async publish(events: readonly DomainEvent[]): Promise<void> {
    this.published.push(...events);
  }
}

const NOW = new Date(1_700_000_000_000);
const HOST = 'teacher-1';
const SESSION = 'session-1';
const ROOM = asId<'LiveRoom'>('room-1');

const room: LiveRoom = {
  id: ROOM,
  halaqaId: 'halaqa-1',
  title: 'Tajweed',
  hostUserId: HOST,
  maxParticipants: 2500,
  createdAt: new Date(0),
};

const liveSession: LiveSession = {
  id: asId<'LiveSession'>(SESSION),
  roomId: ROOM,
  state: 'live',
  startedAt: new Date(0),
  endedAt: null,
};

const pending = (id: string, userId: string): SpeakerRequest => ({
  id: asId<'SpeakerRequest'>(id),
  sessionId: SESSION,
  userId,
  displayName: userId,
  state: 'pending',
  requestedAt: new Date(1),
  decidedAt: null,
  decidedBy: null,
});

function build(authorization: AuthorizationService = allowAll) {
  const requests = new InMemorySpeakerRequestRepository();
  const rtc = new FakeRtcProvider();
  const moderation = new InMemoryModerationLog();
  const events = new RecordingPublisher();
  const audit = new RecordingAuditLog();
  const useCase = new ModerateSpeakerUseCase(
    authorization,
    requests,
    new InMemoryLiveSessionRepository([liveSession]),
    new InMemoryLiveRoomRepository([room]),
    rtc,
    moderation,
    audit,
    new FixedClock(NOW),
    new CountingIdGenerator(),
    events,
  );
  return { useCase, requests, rtc, moderation, events, audit };
}

const host: Principal = { userId: HOST, roles: [], permissions: new Set<string>() };

describe('granting the floor', () => {
  it('refuses a caller without the grant permission and touches nothing', async () => {
    const { useCase, requests, rtc, moderation } = build(denyAll);
    await requests.save(pending('req-1', 'student-1'));

    const result = await useCase.grant({ principal: host, requestId: 'req-1' });

    expect(result.ok).toBe(false);
    expect(rtc.capabilityChanges).toHaveLength(0);
    expect(moderation.actions).toHaveLength(0);
    expect((await requests.findById('req-1'))?.state).toBe('pending');
  });

  it('promotes the participant on the wire and records the decision', async () => {
    const { useCase, requests, rtc, moderation, events } = build();
    await requests.save(pending('req-1', 'student-1'));

    const result = await useCase.grant({ principal: host, requestId: 'req-1' });

    expect(result.ok).toBe(true);
    expect((await requests.findById('req-1'))?.state).toBe('granted');
    expect((await requests.findById('req-1'))?.decidedBy).toBe(HOST);

    // Promoted on the wire…
    expect(rtc.capabilityChanges).toEqual([
      {
        roomName: SESSION,
        identity: 'student-1',
        capabilities: expect.objectContaining({ canPublishAudio: true }),
      },
    ]);
    // …audited…
    expect(moderation.actions).toHaveLength(1);
    expect(moderation.actions[0]).toMatchObject({
      sessionId: SESSION,
      actorUserId: HOST,
      targetUserId: 'student-1',
      type: 'grant_speaker',
      at: NOW,
    });
    // …and announced.
    expect(events.published.map((e) => e.name)).toEqual(['live.speaker.granted']);
  });

  it('refuses once the concurrent speaker limit is reached', async () => {
    const { useCase, requests, rtc } = build();
    for (let i = 0; i < MAX_CONCURRENT_SPEAKERS; i += 1) {
      await requests.save({ ...pending(`granted-${i}`, `u${i}`), state: 'granted' });
    }
    await requests.save(pending('req-1', 'late-student'));

    const result = await useCase.grant({ principal: host, requestId: 'req-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('live.speaker_slots_full');
    expect(rtc.capabilityChanges).toHaveLength(0);
  });

  it('refuses to grant a hand that was already withdrawn', async () => {
    const { useCase, requests } = build();
    await requests.save({ ...pending('req-1', 'student-1'), state: 'withdrawn' });

    const result = await useCase.grant({ principal: host, requestId: 'req-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('live.invalid_transition');
  });

  it('reports an unknown request as not found', async () => {
    const { useCase } = build();
    const result = await useCase.grant({ principal: host, requestId: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
  });
});

describe('revoking the floor', () => {
  it('demotes to listener rather than removing the participant', async () => {
    const { useCase, requests, rtc, moderation, events } = build();
    await requests.save({ ...pending('req-1', 'student-1'), state: 'granted' });

    const result = await useCase.revoke({ principal: host, requestId: 'req-1' });

    expect(result.ok).toBe(true);
    expect((await requests.findById('req-1'))?.state).toBe('revoked');
    expect(rtc.capabilityChanges[0]?.capabilities.canPublishAudio).toBe(false);
    expect(rtc.capabilityChanges[0]?.capabilities.canSubscribe).toBe(true);
    // Demotion is not ejection.
    expect(rtc.removed).toHaveLength(0);
    expect(moderation.actions[0]?.type).toBe('revoke_speaker');
    expect(events.published.map((e) => e.name)).toEqual(['live.speaker.revoked']);
  });

  it('refuses to revoke a hand that is only pending', async () => {
    const { useCase, requests, rtc } = build();
    await requests.save(pending('req-1', 'student-1'));

    const result = await useCase.revoke({ principal: host, requestId: 'req-1' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('live.invalid_transition');
    expect(rtc.capabilityChanges).toHaveLength(0);
  });

  it('frees a speaker slot so the next hand can be granted', async () => {
    const { useCase, requests } = build();
    for (let i = 0; i < MAX_CONCURRENT_SPEAKERS; i += 1) {
      await requests.save({ ...pending(`granted-${i}`, `u${i}`), state: 'granted' });
    }
    await requests.save(pending('req-next', 'next-student'));

    await useCase.revoke({ principal: host, requestId: 'granted-0' });
    const result = await useCase.grant({ principal: host, requestId: 'req-next' });

    expect(result.ok).toBe(true);
  });
});

/**
 * "Is this user allowed to moderate THIS room?" — asked of identity's real
 * authorization service with its provisional rules, not a permissive stub.
 */
describe('moderation is scoped to the room', () => {
  const identity = new PolicyAuthorizationService(PROVISIONAL_POLICY_RULES);
  const teacher = (userId: string) => ({
    userId,
    roles: ['TEACHER'],
    permissions: new Set<string>(PROVISIONAL_ROLE_PERMISSIONS.TEACHER),
  });

  it('lets the host moderate their own room', async () => {
    const { useCase, requests } = build(identity);
    await requests.save(pending('req-1', 'student-1'));
    expect((await useCase.grant({ principal: teacher(HOST), requestId: 'req-1' })).ok).toBe(true);
  });

  it('refuses a teacher who does not host this room, and changes nothing', async () => {
    const { useCase, requests, rtc, audit } = build(identity);
    await requests.save(pending('req-1', 'student-1'));

    const result = await useCase.grant({
      principal: teacher('another-teacher'),
      requestId: 'req-1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('identity.permission_denied');
    expect((await requests.findById('req-1'))?.state).toBe('pending');
    expect(rtc.capabilityChanges).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it('refuses a student outright, before looking the request up', async () => {
    const { useCase, requests } = build(identity);
    const lookup = jest.spyOn(requests, 'findById');
    const student = {
      userId: 'student-1',
      roles: ['STUDENT'],
      permissions: new Set<string>(PROVISIONAL_ROLE_PERMISSIONS.STUDENT),
    };
    const result = await useCase.grant({ principal: student, requestId: 'req-1' });
    expect(result.ok).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("writes the institution's audit trail, not only live's own log", async () => {
    const { useCase, requests, audit } = build(identity);
    await requests.save(pending('req-1', 'student-1'));
    await useCase.grant({ principal: teacher(HOST), requestId: 'req-1' });
    expect(audit.entries).toEqual([
      expect.objectContaining({
        action: 'live.speaker.granted',
        actorUserId: HOST,
        resourceType: 'live.session',
        resourceId: SESSION,
        metadata: { targetUserId: 'student-1' },
      }),
    ]);
  });
});

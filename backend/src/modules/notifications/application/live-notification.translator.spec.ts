import {
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import {
  domainEvent,
  type DomainEvent,
  type EventSubscriber,
  type Principal,
} from '../../../shared';
import { LiveEvents, MAX_AUDIENCE_PROBE, type LiveAudience } from '../../live/contracts';
import { LiveNotificationTranslator } from './live-notification.translator';

/**
 * A LIVE_AUDIENCE stand-in. `moderators` keyset-pages a stored list at its own
 * `pageSize` (short pages are legal per the contract), so a handful of
 * moderators can exercise multi-page fan-out; `failFor` makes a session's
 * lookup reject, as the real contract does when it cannot ask Communities.
 */
class FakeLiveAudience implements LiveAudience {
  pageSize = MAX_AUDIENCE_PROBE;
  private readonly mods = new Map<string, readonly string[]>();
  private readonly failing = new Set<string>();

  setModerators(sessionId: string, userIds: readonly string[]): void {
    this.mods.set(sessionId, userIds);
  }

  failFor(sessionId: string): void {
    this.failing.add(sessionId);
  }

  async participantsAmong(
    _sessionId: string,
    userIds: readonly string[],
  ): Promise<readonly string[]> {
    return userIds;
  }

  async moderators(
    sessionId: string,
    page: { readonly cursor?: string | null; readonly limit: number },
  ): Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }> {
    if (this.failing.has(sessionId)) throw new Error('audience unavailable');
    const all = this.mods.get(sessionId) ?? [];
    const start = page.cursor == null ? 0 : Number(page.cursor);
    const end = Math.min(start + Math.min(this.pageSize, page.limit), all.length);
    return { userIds: all.slice(start, end), nextCursor: end < all.length ? String(end) : null };
  }
}

describe('live speaker notifications', () => {
  let h: NotificationsHarness;
  let audience: FakeLiveAudience;
  let translator: LiveNotificationTranslator;
  let host: Principal;
  let requester: Principal;
  let mod1: Principal;
  let mod2: Principal;
  let mod3: Principal;

  const S = 'session-1';
  const C = 'community-1';

  beforeEach(async () => {
    h = await notificationsHarness();
    host = h.messaging.person('TEACHER', 'الأستاذ أحمد');
    requester = h.messaging.person('STUDENT', 'علي');
    mod1 = h.messaging.person('TEACHER', 'مشرف ١');
    mod2 = h.messaging.person('TEACHER', 'مشرف ٢');
    mod3 = h.messaging.person('TEACHER', 'مشرف ٣');
    audience = new FakeLiveAudience();
    translator = new LiveNotificationTranslator(h.bus, audience, h.dispatcher);
    translator.onModuleInit();
  });

  afterEach(async () => {
    translator.onModuleDestroy();
    await h.cleanup();
  });

  const publish = async (event: DomainEvent): Promise<void> => {
    await h.bus.publish([event]);
    await translator.idle();
  };

  const speakerRequested = (over: Record<string, unknown> = {}): DomainEvent =>
    domainEvent(
      LiveEvents.speakerRequested,
      S,
      {
        sessionId: S,
        communityId: C,
        requestId: 'req-1',
        userId: requester.userId,
        stateVersion: 2,
        ...over,
      },
      h.clock.now(),
    );

  const speakerGranted = (over: Record<string, unknown> = {}): DomainEvent =>
    domainEvent(
      LiveEvents.speakerGranted,
      S,
      {
        sessionId: S,
        communityId: C,
        requestId: 'req-1',
        userId: requester.userId,
        stateVersion: 3,
        grantedBy: host.userId,
        ...over,
      },
      h.clock.now(),
    );

  it('speaker.requested → one notification per moderator, pointing at the live room', async () => {
    audience.setModerators(S, [mod1.userId, mod2.userId]);
    await publish(speakerRequested());

    expect(await h.inbox(mod1)).toEqual([
      expect.objectContaining({
        type: 'LIVE_SPEAKER_REQUESTED',
        category: 'LIVE',
        titleKey: 'notification.live_speaker_requested.title',
        bodyKey: 'notification.live_speaker_requested.body',
        params: {},
        target: { kind: 'live_room', liveSessionId: S },
      }),
    ]);
    expect((await h.inbox(mod2)).map((n) => n.type)).toEqual(['LIVE_SPEAKER_REQUESTED']);
    // The requester is not a moderator here: event semantics are preserved — no
    // recipient is excluded, there is simply no row for a non-recipient.
    expect(await h.inbox(requester)).toEqual([]);
  });

  it('walks every page of moderators — a short page is not the end', async () => {
    audience.setModerators(S, [mod1.userId, mod2.userId, mod3.userId]);
    audience.pageSize = 1; // three single-moderator pages
    await publish(speakerRequested());
    for (const moderator of [mod1, mod2, mod3]) {
      expect((await h.inbox(moderator)).map((n) => n.type)).toEqual(['LIVE_SPEAKER_REQUESTED']);
    }
  });

  it('is created once per moderator however often the same request is delivered', async () => {
    audience.setModerators(S, [mod1.userId, mod2.userId]);
    await publish(speakerRequested());
    await publish(speakerRequested()); // same requestId
    const fact = speakerRequested();
    await Promise.all([translator.translate(fact), translator.translate(fact)]);
    expect((await h.inbox(mod1)).filter((n) => n.type === 'LIVE_SPEAKER_REQUESTED')).toHaveLength(
      1,
    );
    expect((await h.inbox(mod2)).filter((n) => n.type === 'LIVE_SPEAKER_REQUESTED')).toHaveLength(
      1,
    );
  });

  it('does not collapse distinct requests (different request ids)', async () => {
    audience.setModerators(S, [mod1.userId]);
    await publish(speakerRequested());
    await publish(speakerRequested({ requestId: 'req-2' }));
    expect((await h.inbox(mod1)).filter((n) => n.type === 'LIVE_SPEAKER_REQUESTED')).toHaveLength(
      2,
    );
  });

  it('speaker.granted → one notification to the requester, pointing at the live room', async () => {
    await publish(speakerGranted());
    expect(await h.inbox(requester)).toEqual([
      expect.objectContaining({
        type: 'LIVE_SPEAKER_GRANTED',
        category: 'LIVE',
        titleKey: 'notification.live_speaker_granted.title',
        bodyKey: 'notification.live_speaker_granted.body',
        params: {},
        target: { kind: 'live_room', liveSessionId: S },
      }),
    ]);
    await publish(speakerGranted()); // same requestId → still one
    expect(
      (await h.inbox(requester)).filter((n) => n.type === 'LIVE_SPEAKER_GRANTED'),
    ).toHaveLength(1);
  });

  it('ignores a malformed fact instead of guessing', async () => {
    audience.setModerators(S, [mod1.userId]);
    await translator.translate(
      domainEvent(LiveEvents.speakerRequested, S, { sessionId: S, userId: 42 }, h.clock.now()),
    );
    await translator.translate(domainEvent(LiveEvents.speakerGranted, S, null, h.clock.now()));
    expect(await h.inbox(mod1)).toEqual([]);
    expect(h.published.published).toEqual([]);
  });

  it('handles a moderator-contract failure the way every translator does — logged, not thrown', async () => {
    audience.setModerators(S, [mod1.userId]);
    audience.failFor(S);
    await publish(speakerRequested()); // schedule()'s catch swallows the rejection
    expect(await h.inbox(mod1)).toEqual([]);
    // The subscriber survives: a later fact is still translated.
    await publish(speakerGranted());
    expect((await h.inbox(requester)).map((n) => n.type)).toEqual(['LIVE_SPEAKER_GRANTED']);
  });

  it('leaves the dispatcher to skip an account that may not sign in', async () => {
    audience.setModerators(S, [mod1.userId, mod2.userId]);
    h.messaging.directory.deactivate(mod2.userId);
    await publish(speakerRequested());
    expect((await h.inbox(mod1)).map((n) => n.type)).toEqual(['LIVE_SPEAKER_REQUESTED']);
    expect(await h.inbox(mod2)).toEqual([]);
  });

  it('subscribes only to the two speaker events — never to live.session.started', () => {
    const names: string[] = [];
    const recording: EventSubscriber = {
      subscribe: (name) => {
        names.push(name);
        return () => {};
      },
    };
    const probe = new LiveNotificationTranslator(recording, audience, h.dispatcher);
    probe.onModuleInit();
    expect([...names].sort()).toEqual(
      [LiveEvents.speakerGranted, LiveEvents.speakerRequested].sort(),
    );
    expect(names).not.toContain(LiveEvents.sessionStarted);
    probe.onModuleDestroy();
  });

  it('does nothing for live.session.started (its fan-out is a deferred slice)', async () => {
    audience.setModerators(S, [mod1.userId]);
    await publish(
      domainEvent(
        LiveEvents.sessionStarted,
        S,
        { sessionId: S, communityId: C, hostUserId: host.userId },
        h.clock.now(),
      ),
    );
    expect(h.published.published).toEqual([]);
    expect(await h.inbox(mod1)).toEqual([]);
  });

  it('leaves the existing messaging notifications working', async () => {
    const group = await h.messaging.group(host, [requester]);
    await h.settle();
    await h.messaging.text(host, group.id, 'السلام عليكم');
    await h.settle();
    expect((await h.inbox(requester)).filter((n) => n.type === 'MESSAGE_RECEIVED')).toHaveLength(1);
  });
});

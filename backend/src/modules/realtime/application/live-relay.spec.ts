import { Logger } from '@nestjs/common';

import { META, type LiveHarness } from '../../../../test/support/live-harness';
import { credentialsIn } from '../../../../test/support/log-capture';
import {
  liveRealtimeHarness,
  type FakeLink,
  type Frame,
  type LiveRealtimeHarness,
} from '../../../../test/support/realtime-harness';
import { domainEvent, type DomainEvent, type Principal } from '../../../shared';
import { LiveEvents, MAX_AUDIENCE_PROBE, MODERATOR_FRAME_COALESCE_MS } from '../../live/contracts';
import { capabilitiesFor } from '../../live/domain/standing';

/** The live frames a device received, in order. */
const liveFrames = (link: FakeLink): Frame[] =>
  link.frames.filter((frame) => frame.type.startsWith('live.'));
const types = (link: FakeLink) => liveFrames(link).map((frame) => frame.type);
/** What a device was told, as `type` or `type@version`. */
const told = (link: FakeLink) =>
  liveFrames(link).map((frame) =>
    frame.type === 'live.session.changed' ? `changed@${String(frame.stateVersion)}` : frame.type,
  );

/** Every key a live frame may carry: ids, a reason code and versions. */
const LIVE_FRAME_KEYS = [
  'type',
  'eventId',
  'occurredAt',
  'communityId',
  'sessionId',
  'reason',
  'stateVersion',
  'version',
];

/** The display names of the people below, in the directory: none may reach a frame. */
const NAMES = ['الأستاذة عائشة', 'الأستاذة حفصة', 'مريم', 'زينب', 'رقية', 'أسماء'];

/** Only the relay's coalescing timer is faked: everything else runs as usual. */
const ONLY_TIMEOUTS = [
  'Date',
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
] as const;

/** Lets every pending promise callback run, without letting a timer fire. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Enough rights to be in a room, so a removal applies to a scripted participant. */
const LISTENER = capabilitiesFor({
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
  presenterDelegated: false,
});

/**
 * Live's facts over the realtime pipeline (live.md §16;
 * communities-live-attendance.md §16; the P6 plan, commit E): the REAL Live
 * use cases, over the REAL Communities, change the store and publish through
 * Live's journal; an in-process bus hands the events to the relay, which asks
 * Communities' membership and Live's LIVE_AUDIENCE at delivery time. Only the
 * sockets and the coalescing timer are fake.
 */
describe('Live events, delivered in real time', () => {
  let h: LiveRealtimeHarness;
  let l: LiveHarness;
  let communityId: string;
  /** The community's owner, a TEACHER: starts — and so hosts — every session here. */
  let owner: Principal;
  /** A TEACHER holding `community.live.moderate`. */
  let moderator: Principal;
  /** STUDENT members: one raises their hand, one only listens, one will be removed. */
  let speaker: Principal;
  let listener: Principal;
  let leaver: Principal;
  /** Not a member of the community. */
  let outsider: Principal;
  /** Every device any test connected — each one's frames are checked after it. */
  let devices: FakeLink[];

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: [...ONLY_TIMEOUTS] });
    h = liveRealtimeHarness();
    l = h.live;
    devices = [];
    const connect = h.connect.bind(h);
    h.connect = (userId: string) => {
      const device = connect(userId);
      devices.push(device);
      return device;
    };
    const community = await l.community('teacher-1', 'student-1', 'student-2', 'student-3');
    communityId = community.id;
    owner = community.owner;
    [speaker, listener, leaver] = community.students;
    moderator = await l.delegate(communityId, owner, 'teacher-2', 'community.live.moderate');
    outsider = l.person('outsider-1', ['STUDENT']);
    // Names in the directory, so that a frame carrying one would show.
    [owner, moderator, speaker, listener, leaver, outsider].forEach((person, i) =>
      l.accounts.add(person.userId, [i < 2 ? 'TEACHER' : 'STUDENT'], NAMES[i]),
    );
  });

  afterEach(() => {
    // Whatever a test did, every frame it produced carries ids, a reason code
    // and versions only — checked on the bytes, whatever the key.
    const raw = devices.flatMap((device) => device.raw).join('\n');
    for (const name of NAMES) expect(raw).not.toContain(name);
    expect(raw).not.toContain('@');
    expect(credentialsIn(raw)).toEqual([]);
    for (const frame of devices.flatMap((device) => device.frames)) {
      expect(Object.keys(frame).filter((key) => !LIVE_FRAME_KEYS.includes(key))).toEqual([]);
    }
    h.cleanup();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const start = async (): Promise<string> => (await l.startSession(owner, communityId)).id;

  const raise = async (by: Principal, sessionId: string): Promise<string> =>
    (await l.raised(by, sessionId)).id;

  const version = async (sessionId: string): Promise<number> =>
    (await l.session(sessionId)).stateVersion;

  /** Every delivery queued so far, then the moderators' window, then theirs. */
  const afterWindow = async (): Promise<void> => {
    await h.settle();
    await jest.advanceTimersByTimeAsync(MODERATOR_FRAME_COALESCE_MS);
    await h.settle();
  };

  /** A hand fact for this session, as Live publishes one — for storms no use case would make. */
  const handFact = (sessionId: string, stateVersion: number, userId = listener.userId) =>
    domainEvent(
      LiveEvents.speakerRequested,
      sessionId,
      { sessionId, communityId, requestId: `request-${stateVersion}`, userId, stateVersion },
      new Date('2026-09-27T10:00:00.000Z'),
    );

  describe('who hears what', () => {
    it('tells a start and an end to the members online who may take part — once each; an outsider nothing', async () => {
      const devices = [owner, moderator, speaker, listener].map((person) =>
        h.connect(person.userId),
      );
      const stranger = h.connect(outsider.userId);

      const sessionId = await start();
      await h.settle();
      const ended = await l.end.execute({ principal: moderator, sessionId, meta: META });
      if (!ended.ok) throw new Error(ended.error.code);
      await afterWindow();

      const [started, end] = l.journal.events.filter((event) =>
        [LiveEvents.sessionStarted, LiveEvents.sessionEnded].includes(event.name as never),
      );
      for (const device of devices) {
        expect(liveFrames(device)).toEqual([
          {
            type: 'live.session.started',
            eventId: `live.session.started:${sessionId}`,
            occurredAt: started.occurredAt.toISOString(),
            communityId,
            sessionId,
            version: 1,
          },
          {
            type: 'live.session.ended',
            eventId: `live.session.ended:${sessionId}`,
            occurredAt: end.occurredAt.toISOString(),
            communityId,
            sessionId,
            reason: 'moderator',
            version: 1,
          },
        ]);
      }
      expect(stranger.frames).toEqual([]);
    });

    it('tells a start to no one Live would not let take part: a removed member, a suspended account', async () => {
      await l.remove(communityId, owner, leaver.userId);
      l.suspend(listener.userId);
      const removed = h.connect(leaver.userId);
      const suspended = h.connect(listener.userId);
      const member = h.connect(speaker.userId);

      await start();
      await h.settle();

      expect(types(member)).toEqual(['live.session.started']);
      expect(removed.frames).toEqual([]);
      expect(suspended.frames).toEqual([]);
    });

    it('tells a change to its person at once, and to the moderators after the window — a listener hears only the start and the end', async () => {
      const sessionId = await start();
      const host = h.connect(owner.userId);
      const delegate = h.connect(moderator.userId);
      const s = h.connect(speaker.userId);
      const listening = h.connect(listener.userId);
      const stranger = h.connect(outsider.userId);
      const versions: number[] = [];

      // A hand: its owner at once; the moderators only once the window closes.
      const requestId = await raise(speaker, sessionId);
      versions.push(await version(sessionId));
      await h.settle();
      expect(told(s)).toEqual([`changed@${versions[0]}`]);
      expect(told(host)).toEqual([]);
      expect(told(delegate)).toEqual([]);
      await jest.advanceTimersByTimeAsync(MODERATOR_FRAME_COALESCE_MS);
      await h.settle();
      expect(told(host)).toEqual([`changed@${versions[0]}`]);
      expect(told(delegate)).toEqual([`changed@${versions[0]}`]);

      // The floor, given and taken back; the screen, taken and given back.
      const acts = [
        () => l.moderate.grant({ principal: moderator, requestId, meta: META }),
        () => l.presenter.claim({ principal: owner, sessionId, meta: META }),
        () => l.presenter.stop({ principal: owner, sessionId, meta: META }),
        () => l.moderate.revoke({ principal: moderator, requestId, meta: META }),
      ];
      for (const act of acts) {
        const done = await act();
        if (!done.ok) throw new Error(done.error.code);
        versions.push(await version(sessionId));
        await afterWindow();
      }
      const ended = await l.end.execute({ principal: owner, sessionId, meta: META });
      if (!ended.ok) throw new Error(ended.error.code);
      await afterWindow();

      const [raised, granted, claimed, stopped, revoked] = versions.map((v) => `changed@${v}`);
      expect(told(s)).toEqual([raised, granted, revoked, 'live.session.ended']);
      // The presenter is told of their own screen at once, and again as a moderator.
      expect(told(host)).toEqual([
        raised,
        granted,
        claimed,
        claimed,
        stopped,
        stopped,
        revoked,
        'live.session.ended',
      ]);
      expect(told(delegate)).toEqual([
        raised,
        granted,
        claimed,
        stopped,
        revoked,
        'live.session.ended',
      ]);
      expect(told(listening)).toEqual(['live.session.ended']);
      expect(stranger.frames).toEqual([]);
      // Every version the session went through was told to its moderators, in order.
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
      expect(new Set(versions).size).toBe(versions.length);
    });

    it('tells a removed member nothing more — not even of their own hand going down', async () => {
      const sessionId = await start();
      const gone = h.connect(leaver.userId);
      const host = h.connect(owner.userId);
      await raise(leaver, sessionId);
      await afterWindow();
      expect(told(gone)).toEqual([`changed@${await version(sessionId)}`]);

      await l.remove(communityId, owner, leaver.userId);
      const lowered = await l.lower.execute({ principal: leaver, sessionId, meta: META });
      if (!lowered.ok) throw new Error(lowered.error.code);
      await afterWindow();

      // The fact happened, and the moderators heard of it…
      expect(l.eventNames()).toContain(LiveEvents.speakerWithdrawn);
      expect(told(host).slice(-1)).toEqual([`changed@${await version(sessionId)}`]);
      // …and the person it concerns, no longer a member, heard nothing.
      expect(liveFrames(gone)).toHaveLength(1);
    });
  });

  describe('frames', () => {
    it('are built field by field: ids, a reason code and versions — no name, email, count or token', async () => {
      const everyone = [owner, moderator, speaker, listener].map((person) =>
        h.connect(person.userId),
      );
      const sessionId = await start();
      const requestId = await raise(speaker, sessionId);
      await raise(listener, sessionId);
      await l.moderate.grant({ principal: owner, requestId, meta: META });
      await l.presenter.claim({ principal: moderator, sessionId, meta: META });
      await afterWindow();
      await l.end.execute({ principal: owner, sessionId, meta: META });
      await afterWindow();

      const frames = everyone.flatMap((device) => device.frames);
      expect(new Set(frames.map((frame) => frame.type))).toEqual(
        new Set(['live.session.started', 'live.session.changed', 'live.session.ended']),
      );
      for (const frame of frames) {
        expect(Object.keys(frame).filter((key) => !LIVE_FRAME_KEYS.includes(key))).toEqual([]);
        expect(frame).toMatchObject({ communityId, sessionId, version: 1 });
      }
      const raw = everyone.flatMap((device) => device.raw).join('\n');
      for (const name of ['عائشة', 'حفصة', 'مريم', 'زينب']) expect(raw).not.toContain(name);
      expect(raw).not.toContain('@');
      expect(raw).not.toContain(requestId);
      expect(raw).not.toContain(l.room(sessionId));
      expect(credentialsIn(raw)).toEqual([]);
    });
  });

  describe('moderators’ frames, coalesced', () => {
    it('3,000 changes in a burst: at most four frames a second to each moderator, each the latest version, the last the final one', async () => {
      const sessionId = await start();
      const moderators = [h.connect(owner.userId), h.connect(moderator.userId)];
      /** Per moderator: when each frame arrived, and the latest version published by then. */
      const arrivals = moderators.map(() => [] as { at: number; latest: number }[]);
      const record = (latest: number) =>
        moderators.forEach((device, i) => {
          while (arrivals[i].length < liveFrames(device).length) {
            arrivals[i].push({ at: jest.now(), latest });
          }
        });

      // 3,000 changes over one second: three a millisecond.
      let latest = 0;
      for (let ms = 0; ms < 1000; ms += 1) {
        const burst: DomainEvent[] = [];
        for (let i = 0; i < 3; i += 1) burst.push(handFact(sessionId, (latest += 1)));
        await h.bus.publish(burst);
        await h.settle();
        await jest.advanceTimersByTimeAsync(1);
        await h.settle();
        record(latest);
      }
      await afterWindow();
      record(latest);
      expect(latest).toBe(3000);

      for (const [i, device] of moderators.entries()) {
        const frames = liveFrames(device);
        const times = arrivals[i].map((arrival) => arrival.at);
        // Not vacuous: the storm lasted a second, so several windows closed.
        expect(frames.length).toBeGreaterThanOrEqual(4);
        expect(frames.length).toBeLessThanOrEqual(6);
        // At most four in any second.
        for (let k = 0; k + 4 < times.length; k += 1) {
          expect(times[k + 4] - times[k]).toBeGreaterThanOrEqual(1000);
        }
        // Each carries the latest version published when it left — never an older one.
        expect(frames.map((frame) => frame.stateVersion)).toEqual(
          arrivals[i].map((arrival) => arrival.latest),
        );
        expect(frames[frames.length - 1]).toMatchObject({
          stateVersion: 3000,
          eventId: `live.session.changed:${sessionId}:3000`,
        });
      }
      // Both moderators were told the same, byte for byte.
      expect(moderators[0].raw).toEqual(moderators[1].raw);
    });

    it('turns a storm inside one window into one frame per moderator, carrying the latest version', async () => {
      const sessionId = await start();
      const host = h.connect(owner.userId);
      const delegate = h.connect(moderator.userId);
      const moderators = jest.spyOn(h.audience, 'moderators');

      await h.bus.publish(Array.from({ length: 3000 }, (_, i) => handFact(sessionId, i + 1)));
      await h.settle();
      expect(host.frames).toEqual([]);
      await afterWindow();

      for (const device of [host, delegate]) expect(told(device)).toEqual(['changed@3000']);
      // The moderators were asked once, when the window closed.
      expect(moderators).toHaveBeenCalledTimes(1);
    });

    it('keeps a full window between two frames to the moderators, however slowly the audience answers', async () => {
      const sessionId = await start();
      const host = h.connect(owner.userId);
      h.connect(speaker.userId);
      /** When each frame reached the host, on the relay's clock. */
      const arrivals: number[] = [];
      const send = host.send.bind(host);
      host.send = (frame: string) => {
        arrivals.push(jest.now());
        return send(frame);
      };
      // Whether the person a change concerns still takes part is slow to
      // answer: past the first window for the first change, and again for the
      // second, which comes in the middle of that first window.
      const participantsAmong = h.audience.participantsAmong.bind(h.audience);
      const slow = (ms: number) => async (id: string, userIds: readonly string[]) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return participantsAmong(id, userIds);
      };
      jest
        .spyOn(h.audience, 'participantsAmong')
        .mockImplementationOnce(slow(300))
        .mockImplementationOnce(slow(100));
      const t0 = jest.now();

      for (let ms = 0; ms < 1500; ms += 1) {
        if (ms === 0) await h.bus.publish([handFact(sessionId, 1, speaker.userId)]);
        if (ms === 100) await h.bus.publish([handFact(sessionId, 2, speaker.userId)]);
        await jest.advanceTimersByTimeAsync(1);
        for (let i = 0; i < 3; i += 1) await turn();
      }
      await afterWindow();

      expect(told(host)).toEqual(['changed@1', 'changed@2']);
      // Not vacuous: the slow answers held the first frame past its window.
      expect(arrivals[0] - t0).toBeGreaterThan(MODERATOR_FRAME_COALESCE_MS);
      expect(arrivals[1] - arrivals[0]).toBeGreaterThanOrEqual(MODERATOR_FRAME_COALESCE_MS);
    });

    it('asks who moderates when the window closes, not when the change came: one who left meanwhile hears nothing, one who arrived is told', async () => {
      const sessionId = await start();
      const host = h.connect(owner.userId);
      const leaving = h.connect(moderator.userId);
      const arriving = h.connect('teacher-3');

      await h.bus.publish([handFact(sessionId, 1)]);
      await h.settle();
      await l.remove(communityId, owner, moderator.userId);
      await l.delegate(communityId, owner, 'teacher-3', 'community.live.moderate');
      await afterWindow();

      expect(told(host)).toEqual(['changed@1']);
      expect(told(arriving)).toEqual(['changed@1']);
      expect(leaving.frames).toEqual([]);
    });

    it('tells every moderator LIVE_AUDIENCE lists, over as many pages as it takes', async () => {
      const sessionId = await start();
      const host = h.connect(owner.userId);
      const delegate = h.connect(moderator.userId);
      const pages = jest
        .spyOn(h.audience, 'moderators')
        .mockResolvedValueOnce({ userIds: [owner.userId], nextCursor: 'page-2' })
        .mockResolvedValueOnce({ userIds: [], nextCursor: 'page-3' })
        .mockResolvedValueOnce({ userIds: [moderator.userId], nextCursor: null });

      await h.bus.publish([handFact(sessionId, 1)]);
      await afterWindow();

      expect(pages.mock.calls).toEqual([
        [sessionId, { cursor: null, limit: MAX_AUDIENCE_PROBE }],
        [sessionId, { cursor: 'page-2', limit: MAX_AUDIENCE_PROBE }],
        [sessionId, { cursor: 'page-3', limit: MAX_AUDIENCE_PROBE }],
      ]);
      expect(told(host)).toEqual(['changed@1']);
      expect(told(delegate)).toEqual(['changed@1']);
    });

    it('arms nothing once destroyed, even for a change whose delivery was already on its way', async () => {
      const host = h.connect(owner.userId);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const participantsAmong = h.audience.participantsAmong.bind(h.audience);
      jest.spyOn(h.audience, 'participantsAmong').mockImplementationOnce(async (id, userIds) => {
        await gate;
        return participantsAmong(id, userIds);
      });

      const sessionId = await start(); // its audience is slow to answer…
      await h.bus.publish([handFact(sessionId, 1)]); // …and a change waits behind it
      for (let i = 0; i < 10; i += 1) await turn();
      h.relay.onModuleDestroy();
      open();
      await h.settle();

      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(10 * MODERATOR_FRAME_COALESCE_MS);
      await h.settle();
      expect(told(host)).not.toContain('changed@1');
    });

    it('keeps one transient timer per session: unref’d, dropped once it fires, cleared on destroy', async () => {
      const sessionId = await start();
      const host = h.connect(owner.userId);
      const timeouts = jest.spyOn(global, 'setTimeout');

      await h.bus.publish([handFact(sessionId, 1), handFact(sessionId, 2)]);
      await h.settle();
      const armed = timeouts.mock.calls
        .map((call, i) => ({ delay: call[1], timer: timeouts.mock.results[i].value as unknown }))
        .filter((entry) => entry.delay === MODERATOR_FRAME_COALESCE_MS);
      expect(armed).toHaveLength(1);
      expect((armed[0].timer as NodeJS.Timeout).hasRef()).toBe(false);
      expect(jest.getTimerCount()).toBe(1);

      await afterWindow();
      expect(jest.getTimerCount()).toBe(0);
      expect(told(host)).toEqual(['changed@2']);

      await h.bus.publish([handFact(sessionId, 3)]);
      await h.settle();
      expect(jest.getTimerCount()).toBe(1);
      h.relay.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(10 * MODERATOR_FRAME_COALESCE_MS);
      await h.settle();
      expect(told(host)).toEqual(['changed@2']);
    });
  });

  describe('what it costs', () => {
    it('asks for a start ⌈online/1000⌉ times, whatever the community’s size — 2,500 of 4,000 members online, three probes', async () => {
      const students = Array.from(
        { length: 2500 },
        (_, i) => `crowd-${String(i).padStart(4, '0')}`,
      );
      // Members who are not connected here: never asked about.
      const offline = Array.from({ length: 1500 }, (_, i) => `home-${String(i).padStart(4, '0')}`);
      const members = [...students, ...offline];
      for (const id of members) l.person(id, ['STUDENT']);
      for (let from = 0; from < members.length; from += 200) {
        await l.communities.addPeople(owner, communityId, ...members.slice(from, from + 200));
      }
      const strangers = Array.from({ length: 20 }, (_, i) => `stranger-${i}`);
      for (const id of strangers) l.person(id, ['STUDENT']);
      const crowd = students.map((id) => h.connect(id));
      const away = strangers.map((id) => h.connect(id));
      const probes = jest.spyOn(h.audience, 'participantsAmong');
      const pages = jest.spyOn(l.communities.membership, 'members');

      await start();
      await h.settle();

      expect(probes).toHaveBeenCalledTimes(Math.ceil(students.length / MAX_AUDIENCE_PROBE));
      for (const [, ids] of probes.mock.calls) {
        expect(ids.length).toBeLessThanOrEqual(MAX_AUDIENCE_PROBE);
      }
      expect(new Set(probes.mock.calls.flatMap(([, ids]) => ids))).toEqual(new Set(students));
      // One page, then the 2,520 accounts online named a thousand at a time.
      expect(pages.mock.calls.length).toBeLessThanOrEqual(1 + Math.ceil(2520 / 1000));
      for (const device of crowd) expect(types(device)).toEqual(['live.session.started']);
      for (const device of away) expect(device.frames).toEqual([]);
    }, 60_000);

    it('names only the accounts connected here — to Live when it asks, and to the connections when it sends', async () => {
      const online = [owner.userId, speaker.userId];
      const devices = online.map((userId) => h.connect(userId));
      const probes = jest.spyOn(h.audience, 'participantsAmong');
      const toUsers = jest.spyOn(h.connections, 'sendToUsers');
      const toUser = jest.spyOn(h.connections, 'sendToUser');

      const sessionId = await start();
      await h.settle();
      await raise(speaker, sessionId);
      await afterWindow();

      // A small community: its one page of members, narrowed to those online, then one probe.
      expect(probes.mock.calls).toEqual([
        [sessionId, [owner.userId, speaker.userId].sort()],
        [sessionId, [speaker.userId]],
      ]);
      const named = [
        ...toUsers.mock.calls.flatMap(([userIds]) => [...userIds]),
        ...toUser.mock.calls.map(([userId]) => userId),
      ];
      // Not vacuous: a start, the hand's owner, the moderators' window.
      expect(new Set(named)).toEqual(new Set(online));
      for (const device of devices) expect(liveFrames(device).length).toBeGreaterThan(0);
    });

    it('asks nothing, arms nothing and sends nothing when nobody is connected', async () => {
      const relay = jest.spyOn(h.relay, 'relay');
      const asked = [
        jest.spyOn(l.communities.membership, 'members'),
        jest.spyOn(h.audience, 'participantsAmong'),
        jest.spyOn(h.audience, 'moderators'),
      ];

      const sessionId = await start();
      const requestId = await raise(speaker, sessionId);
      await l.moderate.grant({ principal: owner, requestId, meta: META });
      await l.presenter.claim({ principal: owner, sessionId, meta: META });
      await l.end.execute({ principal: owner, sessionId, meta: META });
      await h.settle();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(10 * MODERATOR_FRAME_COALESCE_MS);
      await h.settle();

      // Not vacuous: Live published every one of those facts.
      expect(l.eventNames()).toEqual([
        LiveEvents.sessionStarted,
        LiveEvents.speakerRequested,
        LiveEvents.speakerGranted,
        LiveEvents.screenShareStarted,
        LiveEvents.sessionEnded,
      ]);
      expect(relay).not.toHaveBeenCalled();
      for (const spy of asked) expect(spy).not.toHaveBeenCalled();
    });

    it('asks nothing about the person a change concerns when they are not connected here', async () => {
      const sessionId = await start();
      const host = h.connect(owner.userId);
      const probes = jest.spyOn(h.audience, 'participantsAmong');

      await raise(speaker, sessionId);
      await afterWindow();

      expect(probes).not.toHaveBeenCalled();
      expect(told(host)).toEqual([`changed@${await version(sessionId)}`]);
    });

    it('arms nothing more, and asks no one, when everyone has gone by the time the window closes', async () => {
      const sessionId = await start();
      const host = h.connect(owner.userId);
      const moderators = jest.spyOn(h.audience, 'moderators');
      await h.bus.publish([handFact(sessionId, 1)]);
      await h.settle();

      for (const connection of h.connections.all()) {
        h.connections.unregister(connection.connectionId);
      }
      await afterWindow();

      expect(moderators).not.toHaveBeenCalled();
      expect(host.frames).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('robustness', () => {
    it('delivers one session’s frames in the order its facts were published', async () => {
      const s = h.connect(speaker.userId);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const participantsAmong = h.audience.participantsAmong.bind(h.audience);
      jest
        .spyOn(h.audience, 'participantsAmong')
        .mockImplementationOnce(async (sessionId, userIds) => {
          await gate;
          return participantsAmong(sessionId, userIds);
        });

      const sessionId = await start(); // its audience is slow to answer…
      await raise(speaker, sessionId); // …and the hand comes behind it
      for (let i = 0; i < 10; i += 1) await turn();
      expect(s.frames).toEqual([]);

      open();
      await h.settle();
      expect(told(s)).toEqual(['live.session.started', `changed@${await version(sessionId)}`]);
    });

    it('ignores a malformed event with a warning naming the event only — asking nothing, arming nothing', async () => {
      const sessionId = await start();
      const host = h.connect(owner.userId);
      h.connect(speaker.userId);
      const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const asked = [
        jest.spyOn(l.communities.membership, 'members'),
        jest.spyOn(h.audience, 'participantsAmong'),
        jest.spyOn(h.audience, 'moderators'),
      ];
      const at = new Date();
      const good = { sessionId, communityId, requestId: 'r-1', userId: speaker.userId };
      const malformed: DomainEvent[] = [
        domainEvent(LiveEvents.sessionStarted, sessionId, null, at),
        domainEvent(LiveEvents.sessionStarted, 'another-session', { sessionId, communityId }, at),
        domainEvent(LiveEvents.sessionStarted, sessionId, { sessionId, communityId: '' }, at),
        domainEvent(
          LiveEvents.sessionEnded,
          sessionId,
          { sessionId, communityId, reason: 'secret-reason-xyz' },
          at,
        ),
        domainEvent(LiveEvents.speakerRequested, sessionId, { ...good, stateVersion: -1 }, at),
        domainEvent(LiveEvents.speakerGranted, sessionId, { ...good, stateVersion: 1.5 }, at),
        domainEvent(
          LiveEvents.screenShareStarted,
          sessionId,
          { ...good, stateVersion: '3', token: 'secret-token-xyz' },
          at,
        ),
        domainEvent(
          LiveEvents.speakerRevoked,
          sessionId,
          { sessionId, communityId, stateVersion: 4 },
          at,
        ),
      ];

      await h.bus.publish(malformed);
      await afterWindow();

      expect(host.frames).toEqual([]);
      expect(h.connections.all().every((c) => (c.link as FakeLink).frames.length === 0)).toBe(true);
      for (const spy of asked) expect(spy).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      expect(warned.mock.calls).toEqual(
        malformed.map((event) => [
          { event: 'realtime.live.malformed', name: event.name },
          'ignoring a malformed live event',
        ]),
      );
      expect(JSON.stringify(warned.mock.calls)).not.toMatch(/secret|another-session/);
    });

    it('logs a failing dependency by its class, costs only that frame, and throws nothing into the bus', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const host = h.connect(owner.userId);
      const s = h.connect(speaker.userId);
      jest
        .spyOn(h.audience, 'participantsAmong')
        .mockRejectedValueOnce(new TypeError('secret detail of the start'));

      // The start's audience fails: the use case succeeds all the same, and the start is lost.
      const sessionId = await start();
      await h.settle();
      expect(liveFrames(host)).toEqual([]);

      // The next fact goes out as usual — until the moderators cannot be listed.
      jest
        .spyOn(h.audience, 'moderators')
        .mockRejectedValueOnce(new RangeError('secret detail of the moderators'));
      await raise(speaker, sessionId);
      await afterWindow();
      const raised = await version(sessionId);
      expect(told(s)).toEqual([`changed@${raised}`]);
      expect(told(host)).toEqual([]);

      // …and the window after that is told again, with the latest version.
      await raise(listener, sessionId);
      await afterWindow();
      expect(told(host)).toEqual([`changed@${await version(sessionId)}`]);

      expect(logged.mock.calls).toEqual([
        [
          {
            event: 'realtime.live.delivery_failed',
            name: LiveEvents.sessionStarted,
            sessionId,
            err: { name: 'TypeError' },
          },
          'realtime delivery failed',
        ],
        [
          {
            event: 'realtime.live.delivery_failed',
            name: 'live.session.changed',
            sessionId,
            err: { name: 'RangeError' },
          },
          'realtime delivery failed',
        ],
      ]);
      expect(JSON.stringify(logged.mock.calls)).not.toContain('secret');
    });

    it('stops listening, and forgets its timers, when the module is destroyed', async () => {
      const sessionId = await start();
      const host = h.connect(owner.userId);
      const s = h.connect(speaker.userId);
      h.relay.onModuleDestroy();

      await raise(speaker, sessionId);
      await l.end.execute({ principal: owner, sessionId, meta: META });
      await afterWindow();

      expect(host.frames).toEqual([]);
      expect(s.frames).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('participant control (Q64)', () => {
    it('tells a removed participant they are out — them alone — and no one else of it', async () => {
      const hostDev = h.connect(owner.userId);
      const modDev = h.connect(moderator.userId);
      const speakerDev = h.connect(speaker.userId);
      const leaverDev = h.connect(leaver.userId);
      const sessionId = await start();
      await h.settle();

      // The leaver is in the room, so a moderator's removal applies.
      l.rtc.connect(l.room(sessionId), leaver.userId, LISTENER);
      const removed = await l.kick.execute({
        principal: moderator,
        sessionId,
        targetUserId: leaver.userId,
        meta: META,
      });
      if (!removed.ok) throw new Error(removed.error.code);
      await h.settle();

      // The removed person is told once; the frame names the session, never the reason.
      expect(
        liveFrames(leaverDev).filter((frame) => frame.type === LiveEvents.participantRemoved),
      ).toEqual([
        {
          type: 'live.participant.removed',
          eventId: expect.stringMatching(
            new RegExp(`^live\\.participant\\.removed:${sessionId}:\\d+$`),
          ),
          occurredAt: expect.any(String) as string,
          communityId,
          sessionId,
          version: 1,
        },
      ]);
      // No one else hears of the removal — not the host, not a moderator, not another member.
      for (const device of [hostDev, modDev, speakerDev]) {
        expect(types(device)).not.toContain('live.participant.removed');
      }
    });

    it('tells the removed person even when the participant gate would deny them — the one exception', async () => {
      const leaverDev = h.connect(leaver.userId);
      const sessionId = await start();
      await h.settle(); // the leaver, a member, heard the start through the gate

      // From here the gate denies everyone: a change would be suppressed…
      jest.spyOn(h.audience, 'participantsAmong').mockResolvedValue([]);
      // …yet the removal still reaches the person it concerns, bypassing the gate.
      await h.bus.publish([
        domainEvent(
          LiveEvents.participantRemoved,
          sessionId,
          {
            sessionId,
            communityId,
            userId: leaver.userId,
            removedBy: moderator.userId,
            reason: null,
          },
          new Date('2026-09-27T10:00:00.000Z'),
        ),
      ]);
      await h.settle();

      expect(types(leaverDev)).toEqual(['live.session.started', 'live.participant.removed']);
    });

    it('tells a media reset to the session’s participants, so they re-join — an outsider nothing', async () => {
      const devices = [owner, moderator, speaker, listener].map((person) =>
        h.connect(person.userId),
      );
      const stranger = h.connect(outsider.userId);
      const sessionId = await start();
      await h.settle();

      const reset = await l.reset.execute({ principal: moderator, sessionId, meta: META });
      if (!reset.ok) throw new Error(reset.error.code);
      await h.settle();

      for (const device of devices) {
        expect(liveFrames(device).filter((frame) => frame.type === LiveEvents.mediaReset)).toEqual([
          {
            type: 'live.session.media_reset',
            eventId: `live.session.media_reset:${sessionId}:1`,
            occurredAt: expect.any(String) as string,
            communityId,
            sessionId,
            version: 1,
          },
        ]);
      }
      expect(types(stranger)).not.toContain('live.session.media_reset');
    });
  });
});

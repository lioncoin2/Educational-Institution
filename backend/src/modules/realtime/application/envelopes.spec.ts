import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  communityAccessChangedFrame,
  communityLockedFrame,
  communityMemberAddedFrame,
  communityMemberRemovedFrame,
  communityUnlockedFrame,
  liveSessionChangedFrame,
  liveSessionEndedFrame,
  liveSessionStartedFrame,
} from './envelopes';

/** The golden frames the app's parser reads too (test/fixtures/realtime-frames/README.md). */
const FIXTURES = join(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'realtime-frames');

/** Live's, read by the backend only until the app's live phase parses them (audit D16). */
const LIVE_FIXTURES = join(FIXTURES, 'live');

const golden = (name: string, directory = FIXTURES): unknown =>
  JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8')) as unknown;

const fixtureNames = (directory: string): string[] =>
  readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .sort();

// The inputs every fixture was written from.
const occurredAt = new Date('2026-09-24T10:00:00.000Z');
const communityId = 'community-1';
const userId = 'user-2';

const BUILT: Record<string, string> = {
  'community.member.added': communityMemberAddedFrame({
    occurredAt,
    communityId,
    userId,
    membershipVersion: 7,
  }),
  'community.member.removed.left': communityMemberRemovedFrame({
    occurredAt,
    communityId,
    userId,
    reason: 'left',
    membershipVersion: 8,
  }),
  'community.member.removed.removed': communityMemberRemovedFrame({
    occurredAt,
    communityId,
    userId,
    reason: 'removed',
    membershipVersion: 9,
  }),
  'community.locked': communityLockedFrame({ occurredAt, communityId, lifecycleVersion: 2 }),
  'community.unlocked': communityUnlockedFrame({ occurredAt, communityId, lifecycleVersion: 3 }),
  'community.access.changed': communityAccessChangedFrame({
    occurredAt,
    communityId,
    userId,
    cause: { kind: 'granted', grantId: 'grant-5' },
  }),
};

/**
 * Protocol v1's community frames, pinned to the golden copies the Flutter
 * parser is tested against: a field that changes here without changing
 * there fails one of the two suites.
 */
describe('community frames, as the golden fixtures state them', () => {
  it('has a builder case for every fixture, and a fixture for every case', () => {
    expect(fixtureNames(FIXTURES)).toEqual(Object.keys(BUILT).sort());
  });

  it.each(Object.entries(BUILT))('builds %s exactly — field for field, in order', (name, built) => {
    const fixture = golden(name);
    expect(JSON.parse(built)).toEqual(fixture);
    // Byte for byte: the same keys in the same order, as the app receives them.
    expect(built).toBe(JSON.stringify(fixture));
  });

  it('carries ids, a reason and versions only — no name, title, capability, grant or invitation', () => {
    for (const built of Object.values(BUILT)) {
      const keys = Object.keys(JSON.parse(built) as Record<string, unknown>);
      expect(
        keys.filter(
          (key) =>
            ![
              'type',
              'eventId',
              'occurredAt',
              'communityId',
              'userId',
              'reason',
              'lifecycleVersion',
              'version',
            ].includes(key),
        ),
      ).toEqual([]);
    }
  });

  it('gives a fact the same id however often it is built — a redelivery is a duplicate', () => {
    const granted = { kind: 'granted', grantId: 'grant-5' } as const;
    expect(
      communityAccessChangedFrame({
        occurredAt: new Date(occurredAt),
        communityId,
        userId,
        cause: granted,
      }),
    ).toBe(BUILT['community.access.changed']);
    expect(
      communityMemberAddedFrame({ occurredAt, communityId, userId, membershipVersion: 7 }),
    ).toBe(BUILT['community.member.added']);
    // One fact telling two people is two frames, one per recipient.
    expect(
      communityAccessChangedFrame({ occurredAt, communityId, userId: 'user-3', cause: granted }),
    ).not.toBe(BUILT['community.access.changed']);
  });

  it('never gives two changes of someone’s access the same id, even within one millisecond', () => {
    const at = new Date(occurredAt);
    const ids = [
      { kind: 'granted', grantId: 'grant-5' },
      { kind: 'revoked', grantId: 'grant-5' },
      { kind: 'granted', grantId: 'grant-6' },
      { kind: 'transferred', side: 'from' },
      { kind: 'transferred', side: 'to' },
    ].map(
      (cause) =>
        (
          JSON.parse(
            communityAccessChangedFrame({
              occurredAt: at,
              communityId,
              userId,
              cause: cause as Parameters<typeof communityAccessChangedFrame>[0]['cause'],
            }),
          ) as { eventId: string }
        ).eventId,
    );
    expect(new Set(ids).size).toBe(ids.length);
    // The id names the fact, not the grant or the capability.
    for (const id of ids) {
      expect(id).toMatch(/^community\.access\.changed:community-1:user-2:[0-9a-f]{20}$/);
      expect(id).not.toMatch(/grant|granted|revoked|transferred/);
    }
  });
});

const sessionId = 'session-1';

const LIVE_BUILT: Record<string, string> = {
  'live.session.started': liveSessionStartedFrame({ occurredAt, communityId, sessionId }),
  'live.session.ended.moderator': liveSessionEndedFrame({
    occurredAt,
    communityId,
    sessionId,
    reason: 'moderator',
  }),
  'live.session.ended.idle': liveSessionEndedFrame({
    occurredAt,
    communityId,
    sessionId,
    reason: 'idle',
  }),
  'live.session.ended.community_closed': liveSessionEndedFrame({
    occurredAt,
    communityId,
    sessionId,
    reason: 'community_closed',
  }),
  'live.session.changed': liveSessionChangedFrame({
    occurredAt,
    communityId,
    sessionId,
    stateVersion: 7,
  }),
};

/**
 * Protocol v1's live frames (P6), pinned to their golden copies in `live/`.
 * Hints only: a community, a session, a reason code and a version.
 */
describe('live frames, as the golden fixtures state them', () => {
  it('has a builder case for every fixture in live/, and a fixture for every case', () => {
    expect(fixtureNames(LIVE_FIXTURES)).toEqual(Object.keys(LIVE_BUILT).sort());
  });

  it.each(Object.entries(LIVE_BUILT))(
    'builds %s exactly — field for field, in order',
    (name, built) => {
      const fixture = golden(name, LIVE_FIXTURES);
      expect(JSON.parse(built)).toEqual(fixture);
      expect(built).toBe(JSON.stringify(fixture));
    },
  );

  it('carries ids, a reason code and a version only — no name, count, roster or token', () => {
    for (const built of Object.values(LIVE_BUILT)) {
      const keys = Object.keys(JSON.parse(built) as Record<string, unknown>);
      expect(
        keys.filter(
          (key) =>
            ![
              'type',
              'eventId',
              'occurredAt',
              'communityId',
              'sessionId',
              'reason',
              'stateVersion',
              'version',
            ].includes(key),
        ),
      ).toEqual([]);
    }
  });

  it('names a fact by what it is: a session starts and ends once, and changes once per version', () => {
    const ids = Object.fromEntries(
      Object.entries(LIVE_BUILT).map(([name, built]) => [
        name,
        (JSON.parse(built) as { eventId: string }).eventId,
      ]),
    );
    expect(ids).toEqual({
      'live.session.started': 'live.session.started:session-1',
      'live.session.ended.moderator': 'live.session.ended:session-1',
      'live.session.ended.idle': 'live.session.ended:session-1',
      'live.session.ended.community_closed': 'live.session.ended:session-1',
      'live.session.changed': 'live.session.changed:session-1:7',
    });
    // A redelivery is a duplicate; the next version is not.
    expect(
      liveSessionChangedFrame({
        occurredAt: new Date(occurredAt),
        communityId,
        sessionId,
        stateVersion: 7,
      }),
    ).toBe(LIVE_BUILT['live.session.changed']);
    expect(
      liveSessionChangedFrame({ occurredAt, communityId, sessionId, stateVersion: 8 }),
    ).not.toBe(LIVE_BUILT['live.session.changed']);
  });
});

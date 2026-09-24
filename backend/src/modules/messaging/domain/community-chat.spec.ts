import { asId } from '../../../shared';
import {
  COMMUNITY_CHAT_CREATOR,
  COMMUNITY_HISTORY,
  MAX_APPLY_BATCH,
  advancedProjection,
  checkApplyBatch,
  isCommunityChat,
  newCommunityChat,
  projectMember,
  type CommunityMemberState,
  type ProjectionTransition,
} from './community-chat';
import type { ConversationId } from './conversation';
import type { Participant } from './participant';

const CHAT = asId<'Conversation'>('chat-1') as ConversationId;
const CONVERSATION = { id: CHAT, lastSequence: 40 };
const T0 = new Date('2026-09-23T08:00:00.000Z');
const NOW = new Date('2026-09-23T09:00:00.000Z');
const USER = 'u-1';

const state = (
  version: number,
  active: boolean,
  membershipId = 'm-1',
  joinedAt = T0,
): CommunityMemberState => ({ userId: USER, membershipId, active, joinedAt, version });

/** A projected row as the applier leaves it: MEMBER, added by nobody, with its provenance. */
function row(
  version: number,
  active: boolean,
  membershipId = 'm-1',
  extra: Partial<Participant> = {},
): Participant {
  return {
    conversationId: CHAT,
    userId: USER,
    role: 'MEMBER',
    joinedAt: T0,
    leftAt: active ? null : T0,
    addedBy: null,
    lastReadSequence: 12,
    hiddenThroughSequence: 3,
    sourceVersion: version,
    sourceMembershipId: membershipId,
    sourceJoinedAt: T0,
    ...extra,
  };
}

describe('a community chat', () => {
  it('is a CHANNEL linked to its community, untitled, empty, projected to version 0', () => {
    const chat = newCommunityChat({ id: CHAT, communityId: 'c-1', at: T0 });
    expect(chat).toEqual({
      id: CHAT,
      type: 'CHANNEL',
      title: null,
      createdBy: COMMUNITY_CHAT_CREATOR,
      createdAt: T0,
      directPair: null,
      lastSequence: 0,
      lastMessageAt: null,
      memberCount: 0,
      communityId: 'c-1',
      projectedMembershipVersion: 0,
    });
    expect(isCommunityChat(chat)).toBe(true);
    expect(isCommunityChat({ communityId: null })).toBe(false);
  });

  it('is created by a label that is not an account and never names one', () => {
    expect(COMMUNITY_CHAT_CREATOR).toBe('system:messaging-community-chat');
  });

  it('shows newcomers the whole history by default (PROVISIONAL, Q52)', () => {
    expect(COMMUNITY_HISTORY).toBe('FULL');
  });
});

/**
 * The register, exhaustively (community-chat.md §6.2, §17): every row
 * {absent, ACTIVE, LEFT} × every incoming {ACTIVE same stint, ACTIVE new
 * stint, LEFT} × every version {older, equal, newer}.
 */
describe('projectMember — the truth table', () => {
  type RowKind = 'absent' | 'ACTIVE' | 'LEFT';
  type Incoming = 'ACTIVE same m' | 'ACTIVE new m′' | 'LEFT';
  type Version = 'older' | 'equal' | 'newer';

  const ROW_VERSION = 10;
  const versionOf: Record<Version, number> = { older: 9, equal: 10, newer: 11 };

  const expected: Record<RowKind, Record<Incoming, [ProjectionTransition, -1 | 0 | 1]>> = {
    absent: {
      'ACTIVE same m': ['joined', 1],
      'ACTIVE new m′': ['joined', 1],
      LEFT: ['tombstoned', 0],
    },
    ACTIVE: {
      'ACTIVE same m': ['bumped', 0],
      'ACTIVE new m′': ['rejoined', 0],
      LEFT: ['left', -1],
    },
    LEFT: {
      'ACTIVE same m': ['rejoined', 1],
      'ACTIVE new m′': ['rejoined', 1],
      LEFT: ['bumped', 0],
    },
  };

  const cases: [RowKind, Incoming, Version][] = [];
  for (const rowKind of ['absent', 'ACTIVE', 'LEFT'] as const) {
    for (const incoming of ['ACTIVE same m', 'ACTIVE new m′', 'LEFT'] as const) {
      for (const version of ['older', 'equal', 'newer'] as const) {
        cases.push([rowKind, incoming, version]);
      }
    }
  }

  it.each(cases)('row %s, incoming %s, version %s', (rowKind, incoming, version) => {
    const current = rowKind === 'absent' ? null : row(ROW_VERSION, rowKind === 'ACTIVE');
    const incomingState = state(
      versionOf[version],
      incoming !== 'LEFT',
      incoming === 'ACTIVE new m′' ? 'm-2' : 'm-1',
    );
    const result = projectMember(current, incomingState, CONVERSATION, NOW);

    // A row is a register keyed by the authority's version: nothing but a
    // newer one moves it. An absent row has no version to beat.
    if (current !== null && version !== 'newer') {
      expect(result).toEqual({ next: current, transition: 'ignored', delta: 0 });
      return;
    }
    const [transition, delta] = expected[rowKind][incoming];
    expect({ transition: result.transition, delta: result.delta }).toEqual({ transition, delta });
    const next = result.next;
    if (next === null) throw new Error('a transition always leaves a row');
    // Every transition records where the row came from, and nothing else about it changes shape.
    expect(next).toMatchObject({
      conversationId: CHAT,
      userId: USER,
      role: 'MEMBER',
      addedBy: null,
      sourceVersion: incomingState.version,
      sourceMembershipId: incomingState.membershipId,
      sourceJoinedAt: incomingState.joinedAt,
    });
    expect(next.leftAt === null).toBe(incomingState.active);
    expect(next.hiddenThroughSequence).toBeLessThanOrEqual(next.lastReadSequence);
  });

  it('joins with the watermark at the last sequence and, under FULL, the whole history visible', () => {
    const { next } = projectMember(null, state(1, true), CONVERSATION, NOW);
    expect(next).toMatchObject({ joinedAt: NOW, leftAt: null, lastReadSequence: 40 });
    expect(next?.hiddenThroughSequence).toBe(0);
  });

  it('hides everything up to the join under FROM_JOIN', () => {
    const { next } = projectMember(null, state(1, true), CONVERSATION, NOW, {
      history: 'FROM_JOIN',
    });
    expect(next).toMatchObject({ lastReadSequence: 40, hiddenThroughSequence: 40 });
  });

  it('treats a missed leave as a rejoin: a new stint resets the window and the watermark', () => {
    const { next, transition, delta } = projectMember(
      row(10, true, 'm-1'),
      state(12, true, 'm-2'),
      CONVERSATION,
      NOW,
      { history: 'FROM_JOIN' },
    );
    expect({ transition, delta }).toEqual({ transition: 'rejoined', delta: 0 });
    expect(next).toMatchObject({ joinedAt: NOW, lastReadSequence: 40, hiddenThroughSequence: 40 });
  });

  it('tells a rejoin by the stint id alone — an equal or earlier start changes nothing', () => {
    for (const joinedAt of [T0, new Date(T0.getTime() - 60_000)]) {
      const result = projectMember(
        row(10, true, 'm-1'),
        state(11, true, 'm-2', joinedAt),
        CONVERSATION,
        NOW,
      );
      expect(result.transition).toBe('rejoined');
    }
    // …and the same stint with a later start is still the same stint.
    const same = projectMember(
      row(10, true, 'm-1'),
      state(11, true, 'm-1', new Date(T0.getTime() + 60_000)),
      CONVERSATION,
      NOW,
    );
    expect(same.transition).toBe('bumped');
  });

  it('keeps the watermark and window when a current member is only bumped', () => {
    const { next } = projectMember(row(10, true), state(11, true), CONVERSATION, NOW);
    expect(next).toMatchObject({ lastReadSequence: 12, hiddenThroughSequence: 3, joinedAt: T0 });
  });

  it('ends a membership no earlier than it began, whatever the clock says', () => {
    const late = row(10, true, 'm-1', { joinedAt: NOW });
    const { next } = projectMember(late, state(11, false), CONVERSATION, T0);
    expect(next?.leftAt).toEqual(NOW);
  });

  it('keeps a tombstone that an older ACTIVE can never beat', () => {
    // LEFT at 7 arrives before the ACTIVE at 5 it follows: the tombstone holds.
    const tombstone = projectMember(null, state(7, false), CONVERSATION, NOW);
    expect(tombstone.transition).toBe('tombstoned');
    expect(tombstone.next).toMatchObject({ lastReadSequence: 0, hiddenThroughSequence: 0 });
    const late = projectMember(tombstone.next, state(5, true), CONVERSATION, NOW);
    expect(late).toEqual({ next: tombstone.next, transition: 'ignored', delta: 0 });
  });

  it('treats a row without provenance as version 0', () => {
    const unversioned = row(10, true, 'm-1', {
      sourceVersion: null,
      sourceMembershipId: null,
      sourceJoinedAt: null,
    });
    expect(projectMember(unversioned, state(1, false), CONVERSATION, NOW).transition).toBe('left');
  });

  it('refuses a state for another member, another conversation, or a version below 1', () => {
    expect(() =>
      projectMember(row(1, true), { ...state(2, true), userId: 'someone-else' }, CONVERSATION, NOW),
    ).toThrow(RangeError);
    expect(() =>
      projectMember(
        row(1, true),
        state(2, true),
        { id: asId<'Conversation'>('other'), lastSequence: 0 },
        NOW,
      ),
    ).toThrow(RangeError);
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(() => projectMember(null, state(version, true), CONVERSATION, NOW)).toThrow(
        RangeError,
      );
    }
  });
});

describe('projectMember — the reconciler’s override', () => {
  it('writes the authority’s state over a newer row, lowering its version', () => {
    const ahead = row(50, true, 'm-lost');
    const { next, transition, delta } = projectMember(ahead, state(20, false), CONVERSATION, NOW, {
      override: true,
    });
    expect({ transition, delta }).toEqual({ transition: 'left', delta: -1 });
    expect(next?.sourceVersion).toBe(20);
  });

  it('brings back a member a newer tombstone shut out', () => {
    const { transition, delta } = projectMember(
      row(50, false, 'm-1'),
      state(20, true, 'm-1'),
      CONVERSATION,
      NOW,
      { override: true },
    );
    expect({ transition, delta }).toEqual({ transition: 'rejoined', delta: 1 });
  });

  it('is ignored only when the row already says exactly what the authority says', () => {
    const exact = row(20, true);
    expect(
      projectMember(exact, state(20, true), CONVERSATION, NOW, { override: true }).transition,
    ).toBe('ignored');
    expect(
      projectMember(exact, state(19, true), CONVERSATION, NOW, { override: true }).transition,
    ).toBe('bumped');
  });
});

describe('an apply batch', () => {
  const member = (userId: string): CommunityMemberState => ({ ...state(1, true), userId });

  it('takes up to MAX_APPLY_BATCH members, each once', () => {
    expect(MAX_APPLY_BATCH).toBe(1000);
    expect(() =>
      checkApplyBatch(Array.from({ length: 1000 }, (_, i) => member(`u-${i}`))),
    ).not.toThrow();
    expect(() => checkApplyBatch(Array.from({ length: 1001 }, (_, i) => member(`u-${i}`)))).toThrow(
      RangeError,
    );
    expect(() => checkApplyBatch([member('u-1'), member('u-1')])).toThrow(RangeError);
  });
});

describe('the projected version', () => {
  it('moves only across a contiguous range, and never backwards', () => {
    expect(advancedProjection(10, { from: 10, to: 20 })).toBe(20);
    expect(advancedProjection(15, { from: 10, to: 20 })).toBe(20);
    // Another applier already went further: greatest() keeps it there.
    expect(advancedProjection(50, { from: 10, to: 20 })).toBe(50);
    // Something below `from` is not reflected yet: the range cannot be claimed.
    expect(advancedProjection(5, { from: 10, to: 20 })).toBe(5);
    expect(advancedProjection(7, null)).toBe(7);
  });
});

/**
 * Convergence (§17, property): any permutation, duplication, or
 * loss-then-resend of one member's state log, applied by one to three
 * interleaved appliers, ends at the highest-version state — and the member
 * count moved by the deltas equals the rows left current.
 */
describe('projectMember — convergence', () => {
  /** A deterministic generator, so a failure is reproducible from its seed. */
  function random(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  /** A member's true history: joins and leaves, a new stint on every rejoin. */
  function history(next: () => number, userId: string): CommunityMemberState[] {
    const log: CommunityMemberState[] = [];
    let stint = 0;
    let active = false;
    const changes = 1 + Math.floor(next() * 8);
    for (let version = 1; version <= changes; version++) {
      active = !active;
      if (active) stint += 1;
      log.push({
        userId,
        membershipId: `${userId}-s${stint}`,
        active,
        joinedAt: new Date(T0.getTime() + stint * 1000),
        version: version * 3 + Math.floor(next() * 3),
      });
    }
    return log;
  }

  function shuffled<T>(items: readonly T[], next: () => number): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function run(seed: number): void {
    const next = random(seed);
    const users = Array.from({ length: 1 + Math.floor(next() * 5) }, (_, i) => `u-${i}`);
    const rows = new Map<string, Participant>();
    let memberCount = 0;
    const truth = new Map<string, CommunityMemberState>();

    for (const userId of users) {
      const log = history(next, userId);
      truth.set(userId, log[log.length - 1]);
      // Duplicates, and a loss that is resent later, by 1–3 appliers whose
      // deliveries interleave in any order.
      const deliveries = [...log, ...log.filter(() => next() < 0.5)];
      const appliers = 1 + Math.floor(next() * 3);
      const queues = Array.from({ length: appliers }, () => shuffled(deliveries, next));
      while (queues.some((queue) => queue.length > 0)) {
        const queue = queues[Math.floor(next() * appliers)];
        const delivered = queue?.shift();
        if (delivered === undefined) continue;
        const result = projectMember(rows.get(userId) ?? null, delivered, CONVERSATION, NOW);
        if (result.next !== null) rows.set(userId, result.next);
        memberCount += result.delta;
      }
    }

    for (const [userId, last] of truth) {
      const final = rows.get(userId);
      expect({ seed, version: final?.sourceVersion }).toEqual({ seed, version: last.version });
      expect({ seed, stint: final?.sourceMembershipId }).toEqual({
        seed,
        stint: last.membershipId,
      });
      expect({ seed, active: final?.leftAt === null }).toEqual({ seed, active: last.active });
    }
    expect({ seed, memberCount }).toEqual({
      seed,
      memberCount: [...rows.values()].filter((r) => r.leftAt === null).length,
    });
  }

  it('converges for 200 seeded histories, deliveries and appliers', () => {
    for (let seed = 1; seed <= 200; seed++) run(seed);
  });
});

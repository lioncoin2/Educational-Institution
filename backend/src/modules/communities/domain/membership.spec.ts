import { newCommunity } from './community';
import { endStint, latestStint, memberStint, ownerStint } from './membership';
import { normalizeTitle } from './text';

const at = (ms: number) => new Date(ms);

describe('stints', () => {
  it('creates a community with its creator as owner, first member and first version', () => {
    const community = newCommunity({ id: 'c', title: 'حلقة', createdBy: 'u', at: at(5) });
    const owner = ownerStint({ id: 's', communityId: 'c', userId: 'u', at: at(5) });
    expect(community).toMatchObject({
      status: 'OPEN',
      lifecycleVersion: 1,
      membershipVersion: 1,
      memberCount: 1,
    });
    expect(owner).toMatchObject({
      status: 'ACTIVE',
      standing: 'OWNER',
      source: 'ADDED',
      addedBy: 'u',
      invitationId: null,
      version: community.membershipVersion,
    });
  });

  it('keeps the source and its detail consistent', () => {
    const added = memberStint({
      id: 's1',
      communityId: 'c',
      userId: 'u1',
      source: 'ADDED',
      addedBy: 'owner',
      invitationId: 'ignored',
      at: at(1),
      version: 2,
    });
    const joined = memberStint({
      id: 's2',
      communityId: 'c',
      userId: 'u2',
      source: 'INVITATION',
      addedBy: 'ignored',
      invitationId: 'link',
      at: at(1),
      version: 3,
    });
    expect([added.addedBy, added.invitationId]).toEqual(['owner', null]);
    expect([joined.addedBy, joined.invitationId]).toEqual([null, 'link']);
  });

  it('ends a stint once, never before it began, by the person themself when they leave', () => {
    const stint = memberStint({
      id: 's',
      communityId: 'c',
      userId: 'u',
      source: 'ADDED',
      addedBy: 'owner',
      invitationId: null,
      at: at(100),
      version: 2,
    });
    const left = endStint(stint, { status: 'LEFT', by: 'someone-else', at: at(50), version: 7 });
    expect(left).toMatchObject({ status: 'LEFT', endedAt: at(100), endedBy: 'u', version: 7 });
    const removed = endStint(stint, { status: 'REMOVED', by: 'owner', at: at(200), version: 8 });
    expect(removed).toMatchObject({ status: 'REMOVED', endedAt: at(200), endedBy: 'owner' });
  });

  it('finds the latest stint by version, even when a clock stepped back', () => {
    const first = memberStint({
      id: 'first',
      communityId: 'c',
      userId: 'u',
      source: 'ADDED',
      addedBy: 'owner',
      invitationId: null,
      at: at(1_000),
      version: 2,
    });
    const ended = endStint(first, { status: 'LEFT', by: 'u', at: at(2_000), version: 3 });
    // The rejoin's clock reads EARLIER than the first stint's start.
    const rejoined = memberStint({
      id: 'second',
      communityId: 'c',
      userId: 'u',
      source: 'INVITATION',
      addedBy: null,
      invitationId: 'link',
      at: at(500),
      version: 4,
    });
    expect(latestStint([rejoined, ended])?.id).toBe('second');
    expect(latestStint([])).toBeNull();
  });
});

describe('titles', () => {
  it('trims, and accepts 1 to 100 characters of plain text, counted as Postgres counts them', () => {
    expect(normalizeTitle('  حلقة التجويد  ')).toEqual({ ok: true, value: 'حلقة التجويد' });
    expect(normalizeTitle('ق'.repeat(100)).ok).toBe(true);
    // A character outside the BMP is one character, not two.
    expect(normalizeTitle('𝒜'.repeat(100)).ok).toBe(true);
    // Direction marks are ordinary in Arabic text.
    expect(normalizeTitle('\u200fحلقة').ok).toBe(true);
  });

  it('refuses empty, too long, control and direction-override text', () => {
    const reason = (raw: string) => {
      const result = normalizeTitle(raw);
      return result.ok ? 'ok' : (result.error.details?.reason as string);
    };
    expect(reason('   ')).toBe('empty');
    expect(reason('ق'.repeat(101))).toBe('length');
    for (const bad of ['a\u0000b', 'line\nbreak', 'gpj\u202e.exe', 'x\u2066y', 'a\u2028b']) {
      expect(reason(bad)).toBe('characters');
    }
    const refused = normalizeTitle('');
    expect(refused.ok ? null : refused.error.code).toBe('communities.title_invalid');
  });
});

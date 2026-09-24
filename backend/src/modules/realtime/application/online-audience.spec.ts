import { MAX_MEMBER_PAGE } from '../../communities/contracts/membership';
import { MAX_RECIPIENT_PAGE } from '../../messaging/contracts/message-recipients';
import { AUDIENCE_PAGE, onlineAudience, type AudiencePager } from './online-audience';

/** A deterministic generator, so a failure is reproducible from its seed. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const idOf = (n: number) => `u-${n.toString().padStart(6, '0')}`;

/**
 * An audience source as both real ones behave: members in id order, keyset
 * pages of at most `limit` ids after the cursor, `onlyUserIds` narrowing a
 * page to the members named — and a RangeError for a limit or a list longer
 * than a page, exactly where MESSAGE_RECIPIENTS and COMMUNITY_MEMBERSHIP
 * refuse. Every call is counted.
 */
function source(members: readonly string[]) {
  const sorted = [...members].sort();
  const belongs = new Set(sorted);
  const calls: { onlyUserIds?: readonly string[]; cursor: string | null }[] = [];
  const pageOf: AudiencePager = async (page) => {
    calls.push({ onlyUserIds: page.onlyUserIds, cursor: page.cursor });
    if (page.limit < 1 || page.limit > 1000) throw new RangeError('limit');
    if (page.onlyUserIds !== undefined && page.onlyUserIds.length > 1000) {
      throw new RangeError('onlyUserIds');
    }
    const candidates =
      page.onlyUserIds === undefined
        ? sorted
        : [...new Set(page.onlyUserIds)].filter((userId) => belongs.has(userId)).sort();
    const after = candidates.filter((userId) => page.cursor === null || userId > page.cursor);
    const userIds = after.slice(0, page.limit);
    return {
      userIds,
      nextCursor: after.length > page.limit ? (userIds[userIds.length - 1] ?? null) : null,
    };
  };
  return { pageOf, calls };
}

const bound = (online: number) => 1 + Math.ceil(online / 1000);

describe('onlineAudience', () => {
  it('pages exactly as both sources do: 1,000, the bound of each', () => {
    expect(AUDIENCE_PAGE).toBe(1000);
    expect(MAX_RECIPIENT_PAGE).toBe(AUDIENCE_PAGE);
    expect(MAX_MEMBER_PAGE).toBe(AUDIENCE_PAGE);
  });

  it('asks nothing at all when nobody is online', async () => {
    const { pageOf, calls } = source(Array.from({ length: 30_000 }, (_, n) => idOf(n)));
    expect(await onlineAudience([], pageOf)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('answers an audience that fits one page with that one page', async () => {
    const members = Array.from({ length: 1000 }, (_, n) => idOf(n));
    const { pageOf, calls } = source(members);
    const online = [idOf(3), idOf(999), 'stranger', idOf(3)];

    expect((await onlineAudience(online, pageOf)).sort()).toEqual([idOf(3), idOf(999)]);
    expect(calls).toEqual([{ onlyUserIds: undefined, cursor: null }]);
  });

  it('reaches 50 people online among 30,000 members in at most 2 calls', async () => {
    const members = Array.from({ length: 30_000 }, (_, n) => idOf(n));
    const { pageOf, calls } = source(members);
    const online = [
      ...Array.from({ length: 40 }, (_, n) => idOf(n * 700 + 13)),
      ...Array.from({ length: 10 }, (_, n) => `stranger-${n}`),
    ];

    const audience = await onlineAudience(online, pageOf);

    expect(audience.sort()).toEqual(online.slice(0, 40).sort());
    expect(calls.length).toBeLessThanOrEqual(2);
    // The second call names the people online — never another page of members.
    expect(calls[1]?.onlyUserIds).toHaveLength(50);
  });

  it('names at most a page of people per call, and follows a cursor if a source pages shorter', async () => {
    const members = Array.from({ length: 5000 }, (_, n) => idOf(n));
    const online = members.slice(0, 2500);
    const named: number[] = [];
    // A source that returns at most 400 per page whatever the limit: the
    // cursor is followed, and nobody is lost.
    const short: AudiencePager = async (page) => {
      named.push(page.onlyUserIds?.length ?? 0);
      const candidates = [...(page.onlyUserIds ?? members)].sort();
      const after = candidates.filter((id) => page.cursor === null || id > page.cursor);
      const userIds = after.slice(0, 400);
      return {
        userIds,
        nextCursor: after.length > 400 ? (userIds[userIds.length - 1] ?? null) : null,
      };
    };

    expect((await onlineAudience(online, short)).sort()).toEqual(online);
    expect(Math.max(...named)).toBe(1000);
  });

  /**
   * The property (communities-live-attendance.md §22): for any membership of
   * 0–30,000 and 0–10,000 accounts online — members and strangers mixed —
   * the answer is exactly members ∩ online, each once, within 1 + ⌈A/1000⌉
   * calls, none of them refused by the source.
   */
  it('is members ∩ online within 1 + ⌈A/1000⌉ calls, for 120 seeded audiences', async () => {
    for (let seed = 1; seed <= 120; seed++) {
      const next = random(seed);
      // Sizes spread over the edges as well as the range.
      const pick = (max: number) =>
        [0, 1, 999, 1000, 1001, max][Math.floor(next() * 12)] ?? Math.floor(next() * (max + 1));
      const size = pick(30_000);
      const members = Array.from({ length: size }, (_, n) => idOf(n * 3));
      const onlineCount = pick(10_000);
      const online = Array.from({ length: onlineCount }, () =>
        // Two in three online are members, the rest strangers; some repeat.
        next() < 0.66 && size > 0
          ? idOf(Math.floor(next() * size) * 3)
          : `stranger-${Math.floor(next() * 20_000)}`,
      );
      const { pageOf, calls } = source(members);

      const audience = await onlineAudience(online, pageOf);

      const belongs = new Set(members);
      const expected = [...new Set(online)].filter((userId) => belongs.has(userId)).sort();
      expect({ seed, audience: [...audience].sort() }).toEqual({ seed, audience: expected });
      expect({ seed, once: new Set(audience).size }).toEqual({ seed, once: audience.length });
      const distinct = new Set(online).size;
      expect({ seed, withinBound: calls.length <= bound(distinct) }).toEqual({
        seed,
        withinBound: true,
      });
      if (distinct === 0) expect({ seed, calls: calls.length }).toEqual({ seed, calls: 0 });
      if (distinct > 0 && size <= 1000) {
        expect({ seed, calls: calls.length }).toEqual({ seed, calls: 1 });
      }
    }
  });
});

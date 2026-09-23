import { endGrant, isActiveGrant, newGrant } from './grant';

const base = {
  id: 'g-1',
  communityId: 'c-1',
  membershipId: 'm-1',
  userId: 'u-member',
  capability: 'community.lock' as const,
  grantedBy: 'u-owner',
  at: new Date('2026-09-23T08:00:00Z'),
};

describe('a capability grant (§3.4)', () => {
  it('starts ACTIVE, given by someone other than its holder', () => {
    const grant = newGrant(base);
    expect(isActiveGrant(grant)).toBe(true);
    expect(grant).toMatchObject({ endedAt: null, endedBy: null, endReason: null });
    expect(() => newGrant({ ...base, grantedBy: 'u-member' })).toThrow(/oneself/);
  });

  it('ends once, with a reason, and never before it began', () => {
    const grant = newGrant(base);
    const early = new Date(base.at.getTime() - 60_000);
    const ended = endGrant(grant, { reason: 'revoked', by: 'u-owner', at: early });
    expect(ended).toMatchObject({ endReason: 'revoked', endedBy: 'u-owner', endedAt: base.at });
    expect(isActiveGrant(ended)).toBe(false);
    expect(() => endGrant(ended, { reason: 'membership_ended', by: null, at: new Date() })).toThrow(
      /already ended/,
    );
  });

  it('records who ended it — a system principal as null', () => {
    const ended = endGrant(newGrant(base), {
      reason: 'ownership_changed',
      by: null,
      at: new Date('2026-09-24T08:00:00Z'),
    });
    expect(ended).toMatchObject({ endReason: 'ownership_changed', endedBy: null });
  });
});

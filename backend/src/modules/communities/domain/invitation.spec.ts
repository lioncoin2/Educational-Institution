import {
  InvitationTerms,
  invitationState,
  isTokenShaped,
  validateTerms,
  type Invitation,
} from './invitation';

const link = (overrides: Partial<Invitation> = {}): Invitation => ({
  id: 'link-1',
  communityId: 'community-1',
  tokenHash: 'a'.repeat(64),
  createdBy: 'owner-1',
  createdAt: new Date(0),
  expiresAt: new Date(10_000),
  maxUses: 3,
  uses: 0,
  revokedAt: null,
  revokedBy: null,
  ...overrides,
});

describe('an invitation’s derived state', () => {
  it('is ACTIVE while unrevoked, unexpired and with uses left', () => {
    expect(invitationState(link(), new Date(9_999))).toBe('ACTIVE');
    expect(invitationState(link({ maxUses: null, uses: 1_000_000 }), new Date(1))).toBe('ACTIVE');
  });

  it('expires AT expiresAt, not after it', () => {
    expect(invitationState(link(), new Date(10_000))).toBe('EXPIRED');
  });

  it('is exhausted AT maxUses', () => {
    expect(invitationState(link({ uses: 2 }), new Date(1))).toBe('ACTIVE');
    expect(invitationState(link({ uses: 3 }), new Date(1))).toBe('EXHAUSTED');
  });

  it('ranks REVOKED over EXPIRED over EXHAUSTED', () => {
    const everything = link({ uses: 3, revokedAt: new Date(5), revokedBy: 'owner-1' });
    expect(invitationState(everything, new Date(20_000))).toBe('REVOKED');
    expect(invitationState(link({ uses: 3 }), new Date(20_000))).toBe('EXPIRED');
  });
});

describe('invitation terms (PROVISIONAL, Q48)', () => {
  it('defaults to seven days and no use limit', () => {
    expect(validateTerms({})).toEqual({
      ok: true,
      value: { expiresInSeconds: 604_800, maxUses: null },
    });
  });

  it('accepts the bounds and refuses beyond them, naming the field', () => {
    expect(validateTerms({ expiresInSeconds: 300, maxUses: 1 }).ok).toBe(true);
    expect(
      validateTerms({
        expiresInSeconds: InvitationTerms.maxExpiresInSeconds,
        maxUses: InvitationTerms.maxUsesMax,
      }).ok,
    ).toBe(true);
    for (const [terms, field] of [
      [{ expiresInSeconds: 299 }, 'expiresInSeconds'],
      [{ expiresInSeconds: 2_592_001 }, 'expiresInSeconds'],
      [{ expiresInSeconds: 600.5 }, 'expiresInSeconds'],
      [{ maxUses: 0 }, 'maxUses'],
      [{ maxUses: 2_147_483_648 }, 'maxUses'],
      [{ maxUses: 1.5 }, 'maxUses'],
    ] as const) {
      expect(validateTerms(terms)).toEqual({
        ok: false,
        error: expect.objectContaining({
          kind: 'validation',
          code: 'communities.invitation_terms_invalid',
          details: { field },
        }) as unknown,
      });
    }
  });
});

describe('a token’s shape', () => {
  it('is exactly 43 base64url characters', () => {
    expect(isTokenShaped('A'.repeat(43))).toBe(true);
    expect(isTokenShaped('a-b_c'.padEnd(43, '0'))).toBe(true);
    for (const bad of [
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}+`,
      '',
      43,
      null,
    ]) {
      expect(isTokenShaped(bad)).toBe(false);
    }
  });
});

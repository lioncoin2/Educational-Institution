import {
  ALL_ACCOUNT_STATUSES,
  AccountStatuses,
  authenticationRejection,
  canAuthenticate,
  canTransition,
  endsSessions,
  isAccountStatus,
} from './account-status';

describe('account status', () => {
  it('lets only ACTIVE accounts authenticate', () => {
    expect(ALL_ACCOUNT_STATUSES.filter(canAuthenticate)).toEqual([AccountStatuses.active]);
  });

  it('gives every non-active state a distinct, safe rejection', () => {
    expect(authenticationRejection('ACTIVE')).toBeNull();
    const codes = (['PENDING', 'SUSPENDED', 'DISABLED'] as const).map(
      (status) => authenticationRejection(status)?.code,
    );
    expect(codes).toEqual([
      'identity.account_pending',
      'identity.account_suspended',
      'identity.account_disabled',
    ]);
    for (const status of ['PENDING', 'SUSPENDED', 'DISABLED'] as const) {
      expect(authenticationRejection(status)?.kind).toBe('forbidden');
    }
  });

  it.each([
    ['PENDING', 'ACTIVE', true],
    ['PENDING', 'DISABLED', true],
    ['PENDING', 'SUSPENDED', false],
    ['ACTIVE', 'SUSPENDED', true],
    ['ACTIVE', 'DISABLED', true],
    ['ACTIVE', 'PENDING', false],
    ['SUSPENDED', 'ACTIVE', true],
    ['SUSPENDED', 'DISABLED', true],
    ['DISABLED', 'ACTIVE', true],
    ['DISABLED', 'SUSPENDED', false],
    ['DISABLED', 'PENDING', false],
  ] as const)('%s → %s allowed: %s', (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });

  it('never allows a transition back into PENDING', () => {
    for (const from of ALL_ACCOUNT_STATUSES) expect(canTransition(from, 'PENDING')).toBe(false);
  });

  it('ends sessions exactly when an account is suspended or disabled', () => {
    expect(ALL_ACCOUNT_STATUSES.filter(endsSessions)).toEqual(['SUSPENDED', 'DISABLED']);
  });

  it('recognizes only the four states', () => {
    expect(isAccountStatus('ACTIVE')).toBe(true);
    expect(isAccountStatus('active')).toBe(false);
    expect(isAccountStatus('GRADUATED')).toBe(false);
  });
});

import { canAdminister, canGrantRole, isSelfAdministration } from './administration';

const set = (...permissions: string[]) => new Set(permissions);

describe('administration invariants', () => {
  it('allows administering an account whose permissions are a subset of yours', () => {
    expect(canAdminister(set('a', 'b', 'c'), set('a', 'b'))).toBe(true);
    expect(canAdminister(set('a', 'b'), set('a', 'b'))).toBe(true);
    expect(canAdminister(set('a'), set())).toBe(true);
  });

  it('refuses when the target holds even one permission you do not', () => {
    expect(canAdminister(set('a', 'b'), set('a', 'b', 'settings.manage'))).toBe(false);
  });

  it('refuses granting a role that carries anything you lack', () => {
    expect(canGrantRole(set('live.join'), set('live.join'))).toBe(true);
    expect(canGrantRole(set('live.join'), set('live.join', 'live.moderate'))).toBe(false);
  });

  it('recognizes self-administration', () => {
    expect(isSelfAdministration('u1', 'u1')).toBe(true);
    expect(isSelfAdministration('u1', 'u2')).toBe(false);
  });
});

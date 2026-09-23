import type { Principal } from '../../../shared';
import type { Permission } from '../contracts';
import { evaluateAccess, ownerOfResourceRule, type PolicyRule } from './policy';

const principal = (permissions: string[], userId = 'user-1'): Principal => ({
  userId,
  roles: [],
  permissions: new Set(permissions),
});

const GRANT = 'live.speaker.grant' as Permission;

describe('evaluateAccess', () => {
  it('permits when the role-based permission is held', () => {
    expect(evaluateAccess(principal([GRANT]), GRANT, undefined, [])).toBe(true);
  });

  it('denies when the permission is absent', () => {
    expect(evaluateAccess(principal([]), GRANT, undefined, [])).toBe(false);
  });

  // Deny-overrides is the whole safety property of the evaluator.
  it('lets an explicit deny override a held permission', () => {
    const denyAll: PolicyRule = {
      id: 'deny-all',
      appliesTo: () => true,
      evaluate: () => 'deny',
    };
    expect(evaluateAccess(principal([GRANT]), GRANT, undefined, [denyAll])).toBe(false);
  });

  it('lets a rule permit what roles alone would not', () => {
    const permit: PolicyRule = {
      id: 'permit',
      appliesTo: () => true,
      evaluate: () => 'permit',
    };
    expect(evaluateAccess(principal([]), GRANT, undefined, [permit])).toBe(true);
  });

  it('ignores rules that abstain', () => {
    const abstain: PolicyRule = {
      id: 'abstain',
      appliesTo: () => true,
      evaluate: () => 'abstain',
    };
    expect(evaluateAccess(principal([]), GRANT, undefined, [abstain])).toBe(false);
    expect(evaluateAccess(principal([GRANT]), GRANT, undefined, [abstain])).toBe(true);
  });

  it('denies when one rule permits and another denies', () => {
    const rules: PolicyRule[] = [
      { id: 'permit', appliesTo: () => true, evaluate: () => 'permit' },
      { id: 'deny', appliesTo: () => true, evaluate: () => 'deny' },
    ];
    expect(evaluateAccess(principal([]), GRANT, undefined, rules)).toBe(false);
  });
});

describe('ownerOfResourceRule', () => {
  const rule = ownerOfResourceRule([GRANT]);

  it('permits the owner of the resource', () => {
    expect(evaluateAccess(principal([], 'user-1'), GRANT, { ownerUserId: 'user-1' }, [rule])).toBe(
      true,
    );
  });

  it('does not permit a non-owner', () => {
    expect(evaluateAccess(principal([], 'user-2'), GRANT, { ownerUserId: 'user-1' }, [rule])).toBe(
      false,
    );
  });

  it('does not apply when no owner is supplied', () => {
    expect(rule.appliesTo(GRANT, undefined)).toBe(false);
  });

  it('does not apply to permissions outside its scope', () => {
    expect(rule.appliesTo('files.asset.upload', { ownerUserId: 'u' })).toBe(false);
  });
});

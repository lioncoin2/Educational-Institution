import { ALL_PERMISSIONS, Permissions, isPermission } from './permissions';

describe('permission catalogue', () => {
  it('contains no duplicate permission strings', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('names every permission <namespace>.<action>, as the database CHECK requires', () => {
    for (const permission of ALL_PERMISSIONS) expect(permission).toMatch(/^[a-z]+[.][a-z_]+$/);
  });

  it('covers every namespace the brief names', () => {
    const namespaces = new Set(ALL_PERMISSIONS.map((permission) => permission.split('.')[0]));
    for (const namespace of [
      'people',
      'academic',
      'attendance',
      'assignments',
      'messaging',
      'live',
      'reports',
      'settings',
    ]) {
      expect(namespaces.has(namespace)).toBe(true);
    }
  });

  it('includes the live capabilities the room design depends on', () => {
    expect(Permissions.live).toEqual({
      join: 'live.join',
      raiseHand: 'live.raise_hand',
      speak: 'live.speak',
      moderate: 'live.moderate',
    });
  });

  it('recognizes catalogued permissions only', () => {
    expect(isPermission('live.moderate')).toBe(true);
    expect(isPermission('live.moderate ')).toBe(false);
    expect(isPermission('LIVE.MODERATE')).toBe(false);
    expect(isPermission('live.speaker.grant')).toBe(false); // the Foundation-era name
    expect(isPermission('')).toBe(false);
  });
});

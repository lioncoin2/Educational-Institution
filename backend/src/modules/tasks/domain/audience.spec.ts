import { normaliseAudiences, rolesOf } from './audience';

describe('audiences', () => {
  it('keeps known audiences once, in canonical order', () => {
    expect(normaliseAudiences(['ADMINISTRATION', 'TEACHERS', 'TEACHERS'])).toEqual([
      'TEACHERS',
      'ADMINISTRATION',
    ]);
  });

  it('refuses an empty list or an unknown audience — a task is never sent to a guess', () => {
    expect(normaliseAudiences([])).toBeNull();
    expect(normaliseAudiences(['OWNER'])).toBeNull();
  });

  it('maps teachers to both teaching roles', () => {
    expect(rolesOf(['TEACHERS', 'SUPERVISORS'])).toEqual([
      'TEACHER',
      'ASSISTANT_TEACHER',
      'SUPERVISOR',
    ]);
  });
});

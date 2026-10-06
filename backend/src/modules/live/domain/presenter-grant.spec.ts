import { asId } from '../../../shared';
import {
  PRESENTER_END_REASONS,
  closePresenterGrant,
  isOpenGrant,
  newPresenterGrant,
} from './presenter-grant';

const AT = new Date('2026-09-27T10:00:00.000Z');
const LATER = new Date('2026-09-27T10:05:00.000Z');

const grant = newPresenterGrant({
  id: asId<'PresenterGrant'>('grant-1'),
  sessionId: 'session-1',
  userId: 'teacher-1',
  grantedBy: 'teacher-1',
  at: AT,
});

describe('the presenter grant', () => {
  it('is claimed open, by the presenter for themself (Q56)', () => {
    expect(grant).toEqual({
      id: 'grant-1',
      sessionId: 'session-1',
      userId: 'teacher-1',
      grantedBy: 'teacher-1',
      grantedAt: AT,
      endedAt: null,
      endedBy: null,
      endReason: null,
    });
    expect(isOpenGrant(grant)).toBe(true);
  });

  it('closes once, saying when, by whom and why', () => {
    const closed = closePresenterGrant(grant, { at: LATER, by: 'teacher-2', reason: 'revoked' });
    expect(closed).toMatchObject({ endedAt: LATER, endedBy: 'teacher-2', endReason: 'revoked' });
    expect(isOpenGrant(closed)).toBe(false);
    expect(() =>
      closePresenterGrant(closed, { at: LATER, by: null, reason: 'ineligible' }),
    ).toThrow(RangeError);
  });

  it('knows the four ways a grant ends', () => {
    expect([...PRESENTER_END_REASONS].sort()).toEqual(
      ['ineligible', 'revoked', 'session_ended', 'stopped'].sort(),
    );
  });
});

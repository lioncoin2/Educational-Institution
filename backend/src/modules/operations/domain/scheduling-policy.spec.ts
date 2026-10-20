import { evaluateScheduleTime } from './scheduling-policy';

describe('evaluateScheduleTime', () => {
  const now = new Date('2026-11-01T10:00:00.000Z');

  it('accepts an instant strictly after now', () => {
    expect(evaluateScheduleTime(new Date('2026-11-01T10:01:00.000Z'), now)).toEqual({ ok: true });
  });

  it('rejects an instant exactly at now as past (strict comparison)', () => {
    expect(evaluateScheduleTime(new Date('2026-11-01T10:00:00.000Z'), now)).toEqual({
      ok: false,
      reason: 'in_the_past',
    });
  });

  it('rejects an instant before now as past', () => {
    expect(evaluateScheduleTime(new Date('2026-11-01T09:59:59.000Z'), now)).toEqual({
      ok: false,
      reason: 'in_the_past',
    });
  });
});

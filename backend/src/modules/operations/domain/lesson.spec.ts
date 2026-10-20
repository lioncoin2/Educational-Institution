import { isModifiable, LESSON_TITLE_MAX, normaliseTitle, type Lesson } from './lesson';

function lesson(status: Lesson['status']): Lesson {
  const at = new Date('2026-11-01T11:30:00.000Z');
  return {
    id: 'lesson-1',
    halaqaId: 'halaqa-1',
    title: null,
    local: { date: '2026-11-01', time: '14:30' },
    timezone: 'Asia/Riyadh',
    scheduledAt: at,
    status,
    createdAt: at,
    createdBy: 'owner-1',
    updatedAt: at,
    cancelledAt: status === 'CANCELLED' ? at : null,
    cancelledBy: status === 'CANCELLED' ? 'owner-1' : null,
  };
}

describe('isModifiable', () => {
  it('is true for a SCHEDULED lesson', () => {
    expect(isModifiable(lesson('SCHEDULED'))).toBe(true);
  });

  it('is false for a CANCELLED lesson (terminal)', () => {
    expect(isModifiable(lesson('CANCELLED'))).toBe(false);
  });
});

describe('normaliseTitle', () => {
  it('treats null/undefined/blank as absent', () => {
    expect(normaliseTitle(null)).toEqual({ ok: true, value: null });
    expect(normaliseTitle(undefined)).toEqual({ ok: true, value: null });
    expect(normaliseTitle('   ')).toEqual({ ok: true, value: null });
  });

  it('trims a given title', () => {
    expect(normaliseTitle('  مراجعة  ')).toEqual({ ok: true, value: 'مراجعة' });
  });

  it('accepts a title at the maximum length and rejects over-length', () => {
    expect(normaliseTitle('x'.repeat(LESSON_TITLE_MAX))).toEqual({
      ok: true,
      value: 'x'.repeat(LESSON_TITLE_MAX),
    });
    expect(normaliseTitle('x'.repeat(LESSON_TITLE_MAX + 1))).toEqual({ ok: false });
  });
});

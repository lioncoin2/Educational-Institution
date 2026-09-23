import { asId } from '../../../shared/identifier';
import { alreadyEnded, ended, newEnrollment } from './enrollment';
import type { HalaqaId } from './structure';
import { alreadyAssigned, assignmentEnded, newAssignment } from './teacher-assignment';

const AT = new Date('2026-09-01T08:00:00.000Z');
const LATER = new Date('2026-12-01T08:00:00.000Z');
const HALAQA = 'halaqa-1' as HalaqaId;

function enrollment() {
  return newEnrollment({
    id: asId<'AcademicEnrollment'>('e1'),
    studentUserId: 'student-1',
    halaqaId: HALAQA,
    enrolledBy: 'admin-1',
    at: AT,
  });
}

describe('an enrollment', () => {
  it('starts ACTIVE, not ended, recording who enrolled the student', () => {
    expect(enrollment()).toEqual({
      id: 'e1',
      studentUserId: 'student-1',
      halaqaId: HALAQA,
      status: 'ACTIVE',
      enrolledAt: AT,
      enrolledBy: 'admin-1',
      endedAt: null,
      endedBy: null,
      updatedAt: AT,
    });
  });

  it('ends as COMPLETED or WITHDRAWN, and remembers when and by whom', () => {
    expect(ended(enrollment(), 'COMPLETED', 'admin-2', LATER)).toMatchObject({
      status: 'COMPLETED',
      endedAt: LATER,
      endedBy: 'admin-2',
    });
    expect(ended(enrollment(), 'WITHDRAWN', null, LATER)).toMatchObject({
      status: 'WITHDRAWN',
      endedBy: null,
    });
  });

  it('never ends before it began, whatever a lagging clock says', () => {
    const before = new Date(AT.getTime() - 1000);
    expect(ended(enrollment(), 'WITHDRAWN', null, before).endedAt).toEqual(AT);
  });

  it('treats ending it the same way again as a retry, and another way as rewriting history', () => {
    const completed = ended(enrollment(), 'COMPLETED', 'admin-1', LATER);
    expect(alreadyEnded(completed, 'COMPLETED')).toEqual({ ok: true, value: completed });
    const refused = alreadyEnded(completed, 'WITHDRAWN');
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'academic.enrollment_already_ended', kind: 'conflict' },
    });
  });
});

describe('a teacher assignment', () => {
  function assignment(role: 'TEACHER' | 'ASSISTANT_TEACHER' = 'TEACHER') {
    return newAssignment({
      id: asId<'AcademicTeacherAssignment'>('a1'),
      halaqaId: HALAQA,
      teacherUserId: 'teacher-1',
      role,
      assignedBy: 'admin-1',
      at: AT,
    });
  }

  it('starts ACTIVE in a contextual role for one halaqa', () => {
    expect(assignment('ASSISTANT_TEACHER')).toMatchObject({
      halaqaId: HALAQA,
      role: 'ASSISTANT_TEACHER',
      status: 'ACTIVE',
      startedAt: AT,
      endedAt: null,
    });
  });

  it('ends, and never before it started', () => {
    expect(assignmentEnded(assignment(), 'admin-2', LATER)).toMatchObject({
      status: 'ENDED',
      endedAt: LATER,
      endedBy: 'admin-2',
    });
    expect(assignmentEnded(assignment(), null, new Date(0)).endedAt).toEqual(AT);
  });

  it('accepts a repeat in the same role and refuses a silent change of role', () => {
    expect(alreadyAssigned(assignment(), 'TEACHER').ok).toBe(true);
    expect(alreadyAssigned(assignment(), 'ASSISTANT_TEACHER')).toMatchObject({
      ok: false,
      error: { code: 'academic.teacher_already_assigned', kind: 'conflict' },
    });
  });
});

import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  academicHarness,
  type AcademicHarness,
} from '../../../../test/support/academic-harness';
import type { Principal } from '../../../shared';
import type { Halaqa } from '../domain/structure';

/**
 * Academic records are private. A permission is never enough on its own: a
 * teacher reaches a halaqa's people only through an assignment to THAT
 * halaqa; a student reaches only their own record; administrators reach
 * everything because academic.manage says so, and nobody else does.
 */
describe('academic access and privacy', () => {
  let h: AcademicHarness;
  let admin: Principal;
  let owner: Principal;
  let teacherA: Principal;
  let teacherB: Principal;
  let studentA: Principal;
  let studentB: Principal;
  let supervisor: Principal;
  let halaqaX: Halaqa;
  let halaqaY: Halaqa;

  beforeEach(async () => {
    h = academicHarness();
    admin = h.person('admin', ['ADMIN']);
    owner = h.person('owner', ['OWNER']);
    teacherA = h.person('teacher-a', ['TEACHER'], { displayName: 'الأستاذة عائشة' });
    teacherB = h.person('teacher-b', ['TEACHER'], { displayName: 'الأستاذة سودة' });
    studentA = h.person('student-a', ['STUDENT'], { displayName: 'مريم' });
    studentB = h.person('student-b', ['STUDENT'], { displayName: 'زينب' });
    supervisor = h.person('supervisor', ['SUPERVISOR']);
    await h.seedProfile();
    halaqaX = await h.halaqa('dep-tajweed-2-h1');
    halaqaY = await h.halaqa('dep-tajweed-2-h2');
    await h.assignTo(admin, 'teacher-a', halaqaX.id);
    await h.assignTo(admin, 'teacher-b', halaqaY.id);
    await h.enrollIn(admin, 'student-a', halaqaX.id);
    await h.enrollIn(admin, 'student-b', halaqaY.id);
  });

  function roster(principal: Principal, halaqaId: string) {
    return h.students.execute({ principal, halaqaId });
  }

  it('shows a halaqa’s students to its own teacher, with display names and no emails', async () => {
    const page = expectOk(await roster(teacherA, halaqaX.id));
    expect(page.items).toEqual([
      expect.objectContaining({
        student: { userId: 'student-a', displayName: 'مريم', active: true },
      }),
    ]);
    expect(JSON.stringify(page)).not.toContain('@');
  });

  it('does not let a teacher into a halaqa they are not assigned to', async () => {
    expect(expectErr(await roster(teacherA, halaqaY.id))).toEqual(
      expect.objectContaining({ code: 'academic.halaqa_access_denied', kind: 'forbidden' }),
    );
    expect(expectErr(await roster(teacherB, halaqaX.id)).kind).toBe('forbidden');
    expect(expectOk(await roster(teacherB, halaqaY.id)).items).toEqual([
      expect.objectContaining({ student: expect.objectContaining({ userId: 'student-b' }) }),
    ]);
    expect(
      expectErr(await h.teachers.execute({ principal: teacherA, halaqaId: halaqaY.id })).kind,
    ).toBe('forbidden');
  });

  it('closes a halaqa to its teacher once their assignment ends', async () => {
    const [assignment] = expectOk(
      await h.teachers.execute({ principal: admin, halaqaId: halaqaX.id }),
    ).items;
    if (assignment === undefined) throw new Error('fixture');
    expectOk(
      await h.endAssignment.execute({
        principal: admin,
        assignmentId: assignment.assignment.id,
        meta: META,
      }),
    );
    expect(expectErr(await roster(teacherA, halaqaX.id)).kind).toBe('forbidden');
  });

  it('closes it too when the account no longer holds the TEACHER role — assignment alone is not enough', async () => {
    const demoted = h.person('teacher-a', ['STUDENT']);
    expect(expectErr(await roster(demoted, halaqaX.id)).kind).toBe('forbidden');
  });

  it('never shows a halaqa’s students to a student — not even their own classmates', async () => {
    expect(expectErr(await roster(studentA, halaqaX.id)).kind).toBe('forbidden');
    expect(expectErr(await roster(studentA, halaqaY.id)).kind).toBe('forbidden');
  });

  it('does not open rosters to supervisors: what they may see is not decided (Q31)', async () => {
    expect(expectErr(await roster(supervisor, halaqaX.id)).kind).toBe('forbidden');
  });

  it('opens every halaqa to academic administrators — admin and owner under the provisional matrix', async () => {
    for (const principal of [admin, owner]) {
      expect(expectOk(await roster(principal, halaqaY.id)).items).toHaveLength(1);
    }
  });

  it('says "no such halaqa" for one that does not exist, to anyone', async () => {
    expect(expectErr(await roster(admin, 'nope')).code).toBe('academic.halaqa_not_found');
  });

  it('keeps someone else’s enrollment history for administrators only', async () => {
    for (const principal of [teacherA, studentA, supervisor]) {
      const refused = await h.studentEnrollments.execute({ principal, studentUserId: 'student-b' });
      expect(expectErr(refused).kind).toBe('forbidden');
      const assignments = await h.teacherAssignments.execute({
        principal,
        teacherUserId: 'teacher-b',
      });
      expect(expectErr(assignments).kind).toBe('forbidden');
    }
  });

  describe('my academic record', () => {
    it('shows a student their own enrollment, where it sits and who teaches it — nothing else', async () => {
      const mine = expectOk(await h.me.execute({ principal: studentA }));
      expect(mine).toEqual({
        enrollments: [
          {
            enrollment: expect.objectContaining({ studentUserId: 'student-a', status: 'ACTIVE' }),
            placement: expect.objectContaining({
              section: expect.objectContaining({ code: 'dep-tajweed-2' }),
              halaqa: expect.objectContaining({ code: 'dep-tajweed-2-h1' }),
            }),
            teachers: [{ userId: 'teacher-a', displayName: 'الأستاذة عائشة', role: 'TEACHER' }],
          },
        ],
        teaching: [],
        truncated: false,
      });
      const text = JSON.stringify(mine);
      expect(text).not.toContain('student-b');
      expect(text).not.toContain('زينب');
      expect(text).not.toContain('enrolledBy');
      expect(text).not.toContain('admin');
    });

    it('shows a teacher the halaqat they teach, and no students’ records', async () => {
      const mine = expectOk(await h.me.execute({ principal: teacherA }));
      expect(mine.enrollments).toEqual([]);
      expect(mine.teaching).toEqual([
        {
          assignment: expect.objectContaining({ halaqaId: halaqaX.id, role: 'TEACHER' }),
          placement: expect.objectContaining({
            program: expect.objectContaining({ code: 'dep-tajweed-2-program' }),
          }),
        },
      ]);
      expect(JSON.stringify(mine)).not.toContain('student-a');
    });

    it('keeps the full history, newest first, readable only by its owner', async () => {
      const [current] = expectOk(await h.me.execute({ principal: studentA })).enrollments;
      if (current === undefined) throw new Error('fixture');
      expectOk(
        await h.endEnrollment.execute({
          principal: admin,
          enrollmentId: current.enrollment.id,
          outcome: 'COMPLETED',
          meta: META,
        }),
      );
      h.clock.advance(60);
      await h.enrollIn(admin, 'student-a', (await h.halaqa('dep-tajweed-3-h1')).id);

      const history = expectOk(await h.myEnrollments.execute({ principal: studentA }));
      expect(history.items.map((item) => item.placement.halaqa.code)).toEqual([
        'dep-tajweed-3-h1',
        'dep-tajweed-2-h1',
      ]);
      expect(history.items.map((item) => item.enrollment.status)).toEqual(['ACTIVE', 'COMPLETED']);
      const theirs = expectOk(await h.myEnrollments.execute({ principal: studentB }));
      expect(theirs.items.map((item) => item.enrollment.studentUserId)).toEqual(['student-b']);
    });

    it('is still readable by a student whose account was suspended and restored', async () => {
      h.directory.setActive('student-a', false);
      h.directory.setActive('student-a', true);
      expect(expectOk(await h.me.execute({ principal: studentA })).enrollments).toHaveLength(1);
    });
  });
});

import { expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  academicHarness,
  type AcademicHarness,
} from '../../../../test/support/academic-harness';
import type { Principal } from '../../../shared';
import { ACADEMIC_RELATIONSHIPS_MAX_PAGE } from '../contracts/relationships';
import { newEnrollment } from '../domain/enrollment';
import type { Halaqa } from '../domain/structure';

/**
 * ACADEMIC_RELATIONSHIPS is what future modules (attendance, assignments, a
 * teacher's workspace) will ask. It answers from ACTIVE records only, pages
 * without skipping or repeating, and says nothing about account state.
 */
describe('the academic relationships contract', () => {
  let h: AcademicHarness;
  let admin: Principal;
  let halaqa: Halaqa;

  beforeEach(async () => {
    h = academicHarness();
    admin = h.person('admin', ['ADMIN']);
    h.person('teacher', ['TEACHER']);
    await h.seedProfile();
    halaqa = await h.halaqa('dep-letters-h2');
  });

  async function everyone(limit: number): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await h.relationships.activeStudentIds(halaqa.id, { cursor, limit });
      ids.push(...page.userIds);
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor !== undefined);
    return { ids, pages };
  }

  it('answers "is enrolled" and "teaches" from ACTIVE records only', async () => {
    h.person('student', ['STUDENT']);
    const enrollment = await h.enrollIn(admin, 'student', halaqa.id);
    const assignment = await h.assignTo(admin, 'teacher', halaqa.id);
    const elsewhere = await h.halaqa('dep-letters-h3');
    expect(await h.relationships.isEnrolled('student', halaqa.id)).toBe(true);
    expect(await h.relationships.isEnrolled('student', elsewhere.id)).toBe(false);
    expect(await h.relationships.isTeaching('teacher', halaqa.id)).toBe(true);
    expect(await h.relationships.isTeaching('teacher', elsewhere.id)).toBe(false);
    // A role is not a relationship: the student does not teach, the teacher is not enrolled.
    expect(await h.relationships.isTeaching('student', halaqa.id)).toBe(false);
    expect(await h.relationships.isEnrolled('teacher', halaqa.id)).toBe(false);

    expectOk(
      await h.endEnrollment.execute({
        principal: admin,
        enrollmentId: enrollment.id,
        outcome: 'COMPLETED',
        meta: META,
      }),
    );
    expectOk(
      await h.endAssignment.execute({ principal: admin, assignmentId: assignment.id, meta: META }),
    );
    expect(await h.relationships.isEnrolled('student', halaqa.id)).toBe(false);
    expect(await h.relationships.isTeaching('teacher', halaqa.id)).toBe(false);
  });

  it('lists a halaqa’s ACTIVE students in enrollment order, a page at a time, each once', async () => {
    for (let i = 0; i < 7; i++) {
      h.person(`s${i}`, ['STUDENT']);
      await h.enrollIn(admin, `s${i}`, halaqa.id);
      h.clock.advance(1);
    }
    const [, second] = expectOk(
      await h.students.execute({ principal: admin, halaqaId: halaqa.id }),
    ).items;
    if (second === undefined) throw new Error('fixture');
    expectOk(
      await h.endEnrollment.execute({
        principal: admin,
        enrollmentId: second.enrollment.id,
        outcome: 'WITHDRAWN',
        meta: META,
      }),
    );

    const { ids, pages } = await everyone(3);
    expect(ids).toEqual(['s0', 's2', 's3', 's4', 's5', 's6']);
    expect(pages).toBe(2);
  });

  it('does not ask identity anything: an account’s state is identity’s question', async () => {
    h.person('student', ['STUDENT']);
    await h.enrollIn(admin, 'student', halaqa.id);
    h.directory.setActive('student', false);
    h.directory.calls.length = 0;
    expect(await h.relationships.isEnrolled('student', halaqa.id)).toBe(true);
    expect((await everyone(10)).ids).toEqual(['student']);
    expect(h.directory.calls).toEqual([]);
  });

  it('bounds a page to at least one and at most the contract’s maximum', async () => {
    const total = ACADEMIC_RELATIONSHIPS_MAX_PAGE + 1;
    for (let i = 0; i < total; i++) {
      expect(
        (
          await h.repository.enroll(
            newEnrollment({
              id: h.ids.next<'AcademicEnrollment'>(),
              studentUserId: `bulk-${i}`,
              halaqaId: halaqa.id,
              enrolledBy: 'admin',
              at: h.clock.now(),
            }),
          )
        ).kind,
      ).toBe('created');
    }
    const first = await h.relationships.activeStudentIds(halaqa.id, { limit: 50_000 });
    expect(first.userIds).toHaveLength(ACADEMIC_RELATIONSHIPS_MAX_PAGE);
    expect(first.nextCursor).not.toBeNull();
    const rest = await h.relationships.activeStudentIds(halaqa.id, {
      cursor: first.nextCursor ?? undefined,
      limit: 50_000,
    });
    expect(rest).toEqual({ userIds: [expect.any(String)], nextCursor: null });
    expect(new Set([...first.userIds, ...rest.userIds]).size).toBe(total);
    expect((await h.relationships.activeStudentIds(halaqa.id, { limit: 0 })).userIds).toHaveLength(
      1,
    );
  });

  it('refuses a cursor it did not issue', async () => {
    await expect(
      h.relationships.activeStudentIds(halaqa.id, { cursor: 'forged', limit: 10 }),
    ).rejects.toThrow(RangeError);
  });
});

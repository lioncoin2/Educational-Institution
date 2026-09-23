import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  academicHarness,
  type AcademicHarness,
} from '../../../../test/support/academic-harness';
import type { Principal } from '../../../shared';
import type { Halaqa } from '../domain/structure';

describe('enrollment', () => {
  let h: AcademicHarness;
  let admin: Principal;
  let halaqa: Halaqa;

  beforeEach(async () => {
    h = academicHarness();
    admin = h.person('admin', ['ADMIN']);
    h.person('amina', ['STUDENT'], { displayName: 'آمنة' });
    h.person('sara', ['STUDENT'], { displayName: 'سارة' });
    await h.seedProfile();
    halaqa = await h.halaqa('dep-tajweed-1-h3');
    h.audit.entries.length = 0;
    h.events.published.length = 0;
  });

  function enroll(studentUserId: string, halaqaId: string = halaqa.id, principal = admin) {
    return h.enroll.execute({ principal, halaqaId, studentUserId, meta: META });
  }

  function end(enrollmentId: string, outcome: string) {
    return h.endEnrollment.execute({ principal: admin, enrollmentId, outcome, meta: META });
  }

  it('enrolls a student account in a halaqa, where it sits, audited and announced', async () => {
    const enrolled = expectOk(await enroll('amina'));
    expect(enrolled.created).toBe(true);
    expect(enrolled.enrollment).toMatchObject({
      studentUserId: 'amina',
      halaqaId: halaqa.id,
      status: 'ACTIVE',
      endedAt: null,
    });
    expect(enrolled.placement).toMatchObject({
      section: { code: 'dep-tajweed-1', name: 'قسم تجويد مبتدئ', kind: 'PROGRESSIVE' },
      program: { code: 'dep-tajweed-1-program' },
      halaqa: { code: 'dep-tajweed-1-h3', name: 'الحلقة 3' },
    });
    expect(h.audit.entries).toEqual([
      expect.objectContaining({
        action: 'academic.student.enrolled',
        actorUserId: 'admin',
        resourceType: 'academic.enrollment',
        resourceId: enrolled.enrollment.id,
        metadata: { studentUserId: 'amina', halaqaId: halaqa.id },
      }),
    ]);
    expect(h.events.published).toEqual([
      expect.objectContaining({
        name: 'academic.student.enrolled',
        aggregateId: halaqa.id,
        payload: {
          enrollmentId: enrolled.enrollment.id,
          studentUserId: 'amina',
          halaqaId: halaqa.id,
          programId: enrolled.placement.program.id,
          sectionId: enrolled.placement.section.id,
        },
      }),
    ]);
  });

  it('never makes a second ACTIVE enrollment in the same halaqa — a repeat finds the first', async () => {
    const first = expectOk(await enroll('amina'));
    const again = expectOk(await enroll('amina'));
    expect(again.created).toBe(false);
    expect(again.enrollment.id).toBe(first.enrollment.id);
    expect(h.audit.actions()).toEqual(['academic.student.enrolled']);
    expect(h.events.published).toHaveLength(1);
  });

  it('lets one student be in several halaqat — the profile limits nothing of the kind', async () => {
    expectOk(await enroll('amina'));
    expectOk(await enroll('amina', (await h.halaqa('dep-tajweed-1-h4')).id));
    expectOk(await enroll('amina', (await h.halaqa('dep-literacy-h1')).id));
    const mine = expectOk(await h.me.execute({ principal: h.person('amina', ['STUDENT']) }));
    expect(mine.enrollments).toHaveLength(3);
  });

  it('ends an enrollment explicitly, keeps it as history, and enrolls anew as a new record', async () => {
    const first = expectOk(await enroll('amina')).enrollment;
    h.clock.advance(3600);
    const ended = expectOk(await end(first.id, 'COMPLETED'));
    expect(ended).toMatchObject({ id: first.id, status: 'COMPLETED' });
    expect(ended.endedAt).toEqual(h.clock.now());

    const second = expectOk(await enroll('amina'));
    expect(second.created).toBe(true);
    expect(second.enrollment.id).not.toBe(first.id);

    const history = expectOk(
      await h.studentEnrollments.execute({ principal: admin, studentUserId: 'amina' }),
    );
    expect(history.items.map((item) => [item.enrollment.id, item.enrollment.status])).toEqual([
      [second.enrollment.id, 'ACTIVE'],
      [first.id, 'COMPLETED'],
    ]);
  });

  it('never silently reopens or rewrites an ended enrollment', async () => {
    const enrollment = expectOk(await enroll('amina')).enrollment;
    expectOk(await end(enrollment.id, 'WITHDRAWN'));
    const retry = expectOk(await end(enrollment.id, 'WITHDRAWN'));
    expect(retry.status).toBe('WITHDRAWN');
    expect(expectErr(await end(enrollment.id, 'COMPLETED'))).toEqual(
      expect.objectContaining({ code: 'academic.enrollment_already_ended', kind: 'conflict' }),
    );
    expect(h.audit.actions()).toEqual([
      'academic.student.enrolled',
      'academic.student.enrollment_ended',
    ]);
    expect(h.events.published.map((event) => event.payload)).toContainEqual({
      enrollmentId: enrollment.id,
      studentUserId: 'amina',
      halaqaId: halaqa.id,
      outcome: 'WITHDRAWN',
    });
  });

  it('refuses an outcome that is not COMPLETED or WITHDRAWN, and an unknown enrollment', async () => {
    const enrollment = expectOk(await enroll('amina')).enrollment;
    expect(expectErr(await end(enrollment.id, 'EXPELLED')).code).toBe('academic.outcome_invalid');
    expect(expectErr(await end('no-such-enrollment', 'COMPLETED')).code).toBe(
      'academic.enrollment_not_found',
    );
  });

  describe('where new enrollment is closed', () => {
    it('refuses an inactive halaqa', async () => {
      expectOk(
        await h.halaqaStatus.execute({
          principal: admin,
          halaqaId: halaqa.id,
          status: 'INACTIVE',
          meta: META,
        }),
      );
      expect(expectErr(await enroll('amina'))).toEqual(
        expect.objectContaining({ code: 'academic.halaqa_inactive', kind: 'precondition_failed' }),
      );
    });

    it('refuses an inactive program — while its current students stay enrolled', async () => {
      const current = expectOk(await enroll('sara')).enrollment;
      const program = await h.repository.programByCode('dep-tajweed-1-program');
      if (program === null) throw new Error('seed');
      expectOk(
        await h.programStatus.execute({
          principal: admin,
          programId: program.id,
          status: 'INACTIVE',
          meta: META,
        }),
      );
      expect(expectErr(await enroll('amina')).code).toBe('academic.program_inactive');
      expect((await h.repository.findEnrollment(current.id))?.status).toBe('ACTIVE');
    });

    it('refuses an inactive section — while its history stays readable', async () => {
      const current = expectOk(await enroll('sara')).enrollment;
      const section = await h.repository.sectionByCode('dep-tajweed-1');
      if (section === null) throw new Error('seed');
      expectOk(
        await h.sectionStatus.execute({
          principal: admin,
          sectionId: section.id,
          status: 'INACTIVE',
          meta: META,
        }),
      );
      expect(expectErr(await enroll('amina')).code).toBe('academic.section_inactive');
      const roster = expectOk(await h.students.execute({ principal: admin, halaqaId: halaqa.id }));
      expect(roster.items.map((item) => item.enrollment.id)).toEqual([current.id]);
    });

    it('refuses a halaqa that does not exist', async () => {
      expect(expectErr(await enroll('amina', 'no-such-halaqa')).code).toBe(
        'academic.halaqa_not_found',
      );
    });
  });

  describe('who may be enrolled', () => {
    it('only an ACTIVE account that may study — identity decides, academic asks', async () => {
      h.person('ustadh', ['TEACHER']);
      h.person('suspended', ['STUDENT'], { active: false });
      for (const userId of ['ustadh', 'suspended', 'nobody-at-all']) {
        expect(expectErr(await enroll(userId))).toEqual(
          expect.objectContaining({ code: 'academic.student_not_eligible', kind: 'validation' }),
        );
      }
    });

    it('a staff member who also holds the STUDENT role', async () => {
      h.person('assistant', ['ASSISTANT_TEACHER', 'STUDENT']);
      expect(expectOk(await enroll('assistant')).created).toBe(true);
    });
  });

  it('is only ever an administrator’s act — never a teacher’s, a student’s or a supervisor’s', async () => {
    const teacher = h.person('ustadh', ['TEACHER']);
    await h.assignTo(admin, 'ustadh', halaqa.id);
    const student = h.person('amina', ['STUDENT']);
    const supervisor = h.person('mushrifa', ['SUPERVISOR']);
    for (const principal of [teacher, student, supervisor]) {
      expect(expectErr(await enroll('amina', halaqa.id, principal)).kind).toBe('forbidden');
    }
    expect(await h.relationships.isEnrolled('amina', halaqa.id)).toBe(false);
  });

  it('keeps an enrollment ACTIVE when the account is suspended: academic and account state differ', async () => {
    const enrollment = expectOk(await enroll('amina')).enrollment;
    h.directory.setActive('amina', false);
    expect((await h.repository.findEnrollment(enrollment.id))?.status).toBe('ACTIVE');
    const roster = expectOk(await h.students.execute({ principal: admin, halaqaId: halaqa.id }));
    expect(roster.items).toEqual([
      expect.objectContaining({ student: { userId: 'amina', displayName: 'آمنة', active: false } }),
    ]);
    h.directory.setActive('amina', true);
    expect(expectOk(await enroll('amina')).created).toBe(false);
  });

  it('records no name, email or other personal detail in audit entries or events', async () => {
    const enrollment = expectOk(await enroll('amina')).enrollment;
    expectOk(await end(enrollment.id, 'COMPLETED'));
    const recorded = h.recorded();
    expect(recorded).not.toContain('آمنة');
    expect(recorded).not.toContain('@');
  });
});

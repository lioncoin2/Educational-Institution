import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  academicHarness,
  type AcademicHarness,
} from '../../../../test/support/academic-harness';
import type { Principal } from '../../../shared';
import type { Halaqa } from '../domain/structure';

describe('teacher assignment', () => {
  let h: AcademicHarness;
  let admin: Principal;
  let halaqa: Halaqa;

  beforeEach(async () => {
    h = academicHarness();
    admin = h.person('admin', ['ADMIN']);
    h.person('ustadha', ['TEACHER'], { displayName: 'الأستاذة فاطمة' });
    h.person('musaaida', ['ASSISTANT_TEACHER'], { displayName: 'المساعدة خديجة' });
    await h.seedProfile();
    halaqa = await h.halaqa('dep-letters-h4');
    h.audit.entries.length = 0;
    h.events.published.length = 0;
  });

  function assign(teacherUserId: string, role = 'TEACHER', halaqaId: string = halaqa.id) {
    return h.assign.execute({ principal: admin, halaqaId, teacherUserId, role, meta: META });
  }

  it('assigns a teaching account to one halaqa, in a role, audited and announced', async () => {
    const assigned = expectOk(await assign('ustadha'));
    expect(assigned.created).toBe(true);
    expect(assigned.assignment).toMatchObject({
      halaqaId: halaqa.id,
      teacherUserId: 'ustadha',
      role: 'TEACHER',
      status: 'ACTIVE',
      endedAt: null,
    });
    expect(h.audit.last('academic.teacher.assigned')).toMatchObject({
      actorUserId: 'admin',
      resourceType: 'academic.teacher_assignment',
      metadata: { teacherUserId: 'ustadha', halaqaId: halaqa.id, role: 'TEACHER' },
    });
    expect(h.events.published).toEqual([
      expect.objectContaining({
        name: 'academic.teacher.assigned',
        aggregateId: halaqa.id,
        payload: {
          assignmentId: assigned.assignment.id,
          teacherUserId: 'ustadha',
          halaqaId: halaqa.id,
          role: 'TEACHER',
        },
      }),
    ]);
  });

  it('lets a halaqa have several teachers, and a teacher several halaqat', async () => {
    expectOk(await assign('ustadha'));
    h.clock.advance(1);
    expectOk(await assign('musaaida', 'ASSISTANT_TEACHER'));
    h.clock.advance(1);
    expectOk(await assign('ustadha', 'TEACHER', (await h.halaqa('dep-letters-h5')).id));
    const teachers = expectOk(await h.teachers.execute({ principal: admin, halaqaId: halaqa.id }));
    expect(teachers.items.map((item) => [item.teacher.displayName, item.assignment.role])).toEqual([
      ['الأستاذة فاطمة', 'TEACHER'],
      ['المساعدة خديجة', 'ASSISTANT_TEACHER'],
    ]);
    const mine = expectOk(await h.me.execute({ principal: h.person('ustadha', ['TEACHER']) }));
    expect(mine.teaching.map((item) => item.placement.halaqa.code)).toEqual([
      'dep-letters-h4',
      'dep-letters-h5',
    ]);
  });

  it('never makes a second ACTIVE assignment — a repeat finds it, another role is refused', async () => {
    const first = expectOk(await assign('ustadha'));
    const again = expectOk(await assign('ustadha'));
    expect(again).toEqual({ assignment: first.assignment, created: false });
    expect(expectErr(await assign('ustadha', 'ASSISTANT_TEACHER'))).toEqual(
      expect.objectContaining({ code: 'academic.teacher_already_assigned', kind: 'conflict' }),
    );
    expect(h.audit.actions()).toEqual(['academic.teacher.assigned']);
  });

  it('ends an assignment, keeps it as history, and may assign the person again', async () => {
    const first = expectOk(await assign('ustadha')).assignment;
    h.clock.advance(60);
    const ended = expectOk(
      await h.endAssignment.execute({ principal: admin, assignmentId: first.id, meta: META }),
    );
    expect(ended).toMatchObject({ id: first.id, status: 'ENDED', endedAt: h.clock.now() });
    const repeat = expectOk(
      await h.endAssignment.execute({ principal: admin, assignmentId: first.id, meta: META }),
    );
    expect(repeat.status).toBe('ENDED');
    expect(h.audit.actions()).toEqual([
      'academic.teacher.assigned',
      'academic.teacher.assignment_ended',
    ]);

    const second = expectOk(await assign('ustadha', 'ASSISTANT_TEACHER'));
    expect(second.created).toBe(true);
    const history = expectOk(
      await h.teacherAssignments.execute({ principal: admin, teacherUserId: 'ustadha' }),
    );
    expect(history.items.map((item) => item.assignment.status)).toEqual(['ACTIVE', 'ENDED']);
    const ended2 = expectOk(
      await h.teachers.execute({ principal: admin, halaqaId: halaqa.id, status: 'ENDED' }),
    );
    expect(ended2.items.map((item) => item.assignment.id)).toEqual([first.id]);
  });

  it('only assigns an ACTIVE account that may teach', async () => {
    h.person('talib', ['STUDENT']);
    h.person('mushrifa', ['SUPERVISOR']);
    h.person('away', ['TEACHER'], { active: false });
    for (const userId of ['talib', 'mushrifa', 'away', 'unknown-account']) {
      expect(expectErr(await assign(userId))).toEqual(
        expect.objectContaining({ code: 'academic.teacher_not_eligible', kind: 'validation' }),
      );
    }
  });

  it('refuses a role outside the institution’s vocabulary, and a missing halaqa', async () => {
    expect(expectErr(await assign('ustadha', 'HEAD_TEACHER')).code).toBe('academic.role_invalid');
    expect(expectErr(await assign('ustadha', 'TEACHER', 'no-such-halaqa')).code).toBe(
      'academic.halaqa_not_found',
    );
    expect(
      expectErr(
        await h.endAssignment.execute({ principal: admin, assignmentId: 'nope', meta: META }),
      ).code,
    ).toBe('academic.teacher_assignment_not_found');
  });

  it('may prepare a halaqa that is not yet open', async () => {
    expectOk(
      await h.halaqaStatus.execute({
        principal: admin,
        halaqaId: halaqa.id,
        status: 'INACTIVE',
        meta: META,
      }),
    );
    expect(expectOk(await assign('ustadha')).created).toBe(true);
  });

  it('is an administrator’s act — a teacher cannot assign themselves anywhere', async () => {
    const teacher = h.person('ustadha', ['TEACHER']);
    const refused = await h.assign.execute({
      principal: teacher,
      halaqaId: halaqa.id,
      teacherUserId: 'ustadha',
      role: 'TEACHER',
      meta: META,
    });
    expect(expectErr(refused).kind).toBe('forbidden');
    expect(await h.relationships.isTeaching('ustadha', halaqa.id)).toBe(false);
  });
});

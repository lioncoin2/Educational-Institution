import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  academicHarness,
  type AcademicHarness,
} from '../../../../test/support/academic-harness';
import type { Principal } from '../../../shared';
import { AcademicLimits } from '../domain/academic-policy';
import type { Halaqa } from '../domain/structure';

describe('reading academic data', () => {
  let h: AcademicHarness;
  let admin: Principal;
  let student: Principal;

  beforeEach(async () => {
    h = academicHarness();
    admin = h.person('admin', ['ADMIN']);
    student = h.person('student', ['STUDENT']);
    await h.seedProfile();
  });

  describe('the catalogue', () => {
    it('is every section in order, each with its programs and active halaqat counted', async () => {
      const sections = expectOk(await h.catalogue.execute({ principal: student }));
      expect(sections.map((s) => [s.code, s.kind, s.order])).toEqual([
        ['dep-literacy', 'PROGRESSIVE', 1],
        ['dep-letters', 'PROGRESSIVE', 2],
        ['dep-tajweed-1', 'PROGRESSIVE', 3],
        ['dep-tajweed-2', 'PROGRESSIVE', 4],
        ['dep-tajweed-3', 'PROGRESSIVE', 5],
        ['sec-spelling', 'SPECIAL', 6],
        ['sec-kids', 'SPECIAL', 7],
        ['sec-languages', 'SPECIAL', 8],
        ['accompanying', 'ACCOMPANYING', 9],
      ]);
      expect(sections.flatMap((s) => s.programs.map((p) => [p.code, p.activeHalaqaCount]))).toEqual(
        [
          ['dep-literacy-program', 5],
          ['dep-letters-program', 10],
          ['dep-tajweed-1-program', 10],
          ['dep-tajweed-2-program', 10],
          ['dep-tajweed-3-program', 10],
          ['prog-hifz-city', 0],
          ['prog-nahw', 0],
          ['prog-maqari', 0],
          ['prog-mutun', 0],
        ],
      );
    });

    it('counts only ACTIVE halaqat, and keeps inactive entries visible and marked', async () => {
      const halaqa = await h.halaqa('dep-literacy-h5');
      expectOk(
        await h.halaqaStatus.execute({
          principal: admin,
          halaqaId: halaqa.id,
          status: 'INACTIVE',
          meta: META,
        }),
      );
      const [literacy] = expectOk(await h.catalogue.execute({ principal: student }));
      expect(literacy?.programs[0]?.activeHalaqaCount).toBe(4);
      const program = expectOk(
        await h.getProgram.execute({
          principal: student,
          programId: literacy?.programs[0]?.id ?? '',
        }),
      );
      expect(program.halaqat.map((x) => [x.code, x.status])).toEqual([
        ['dep-literacy-h1', 'ACTIVE'],
        ['dep-literacy-h2', 'ACTIVE'],
        ['dep-literacy-h3', 'ACTIVE'],
        ['dep-literacy-h4', 'ACTIVE'],
        ['dep-literacy-h5', 'INACTIVE'],
      ]);
      expect(program.program.activeHalaqaCount).toBe(4);
    });

    it('orders by position, then code — whatever order things were created in', async () => {
      const [, letters] = expectOk(await h.catalogue.execute({ principal: student }));
      const program = expectOk(
        await h.getProgram.execute({
          principal: student,
          programId: letters?.programs[0]?.id ?? '',
        }),
      );
      expect(program.halaqat.map((x) => x.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('answers one section, one program with its halaqat, and one halaqa with where it sits', async () => {
      const [section] = expectOk(await h.catalogue.execute({ principal: student }));
      const one = expectOk(
        await h.getSection.execute({ principal: student, sectionId: section?.id ?? '' }),
      );
      expect(one).toMatchObject({
        code: 'dep-literacy',
        programs: [{ code: 'dep-literacy-program' }],
      });
      const halaqa = await h.halaqa('dep-literacy-h2');
      expect(
        expectOk(await h.getHalaqa.execute({ principal: student, halaqaId: halaqa.id })),
      ).toEqual({
        halaqa: expect.objectContaining({ code: 'dep-literacy-h2', name: 'الحلقة 2' }),
        program: expect.objectContaining({ code: 'dep-literacy-program' }),
        section: expect.objectContaining({ code: 'dep-literacy', kind: 'PROGRESSIVE' }),
      });
      for (const missing of [
        await h.getSection.execute({ principal: student, sectionId: 'nope' }),
        await h.getProgram.execute({ principal: student, programId: 'nope' }),
        await h.getHalaqa.execute({ principal: student, halaqaId: 'nope' }),
      ]) {
        expect(expectErr(missing).kind).toBe('not_found');
      }
    });

    it('is open to every role, and to no one without academic.read', async () => {
      for (const roles of [
        ['OWNER'],
        ['ADMIN'],
        ['SUPERVISOR'],
        ['TEACHER'],
        ['ASSISTANT_TEACHER'],
        ['STUDENT'],
      ] as const) {
        expect(
          expectOk(await h.catalogue.execute({ principal: h.person('someone', roles) })),
        ).toHaveLength(9);
      }
      const nobody: Principal = { userId: 'nobody', roles: [], permissions: new Set() };
      expect(expectErr(await h.catalogue.execute({ principal: nobody })).kind).toBe('forbidden');
      expect(expectErr(await h.me.execute({ principal: nobody })).kind).toBe('forbidden');
    });
  });

  describe('rosters', () => {
    let halaqa: Halaqa;

    beforeEach(async () => {
      halaqa = await h.halaqa('dep-tajweed-3-h7');
      for (let i = 0; i < 12; i++) {
        h.person(`s${String(i).padStart(2, '0')}`, ['STUDENT'], { displayName: `طالبة ${i}` });
      }
    });

    it('are paged by cursor, in enrollment order, each student once, with one directory call per page', async () => {
      for (let i = 0; i < 12; i++) {
        await h.enrollIn(admin, `s${String(i).padStart(2, '0')}`, halaqa.id);
        if (i % 3 === 0) h.clock.advance(1); // several share an instant: ties are broken by id
      }
      h.directory.calls.length = 0;

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = expectOk(
          await h.students.execute({ principal: admin, halaqaId: halaqa.id, limit: 5, cursor }),
        );
        pages++;
        seen.push(...page.items.map((item) => item.student.userId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);

      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(12);
      expect(seen).toHaveLength(12);
      const whole = expectOk(
        await h.students.execute({ principal: admin, halaqaId: halaqa.id, limit: 50 }),
      );
      expect(seen).toEqual(whole.items.map((item) => item.student.userId));
      const describes = h.directory.calls.filter((call) => call.method === 'describe');
      expect(describes.map((call) => call.ids)).toEqual([5, 5, 2, 12]);
    });

    it('list by status, and refuse a status or a cursor that is not one of theirs', async () => {
      const enrollment = await h.enrollIn(admin, 's00', halaqa.id);
      await h.enrollIn(admin, 's01', halaqa.id);
      expectOk(
        await h.endEnrollment.execute({
          principal: admin,
          enrollmentId: enrollment.id,
          outcome: 'COMPLETED',
          meta: META,
        }),
      );
      const completed = expectOk(
        await h.students.execute({ principal: admin, halaqaId: halaqa.id, status: 'COMPLETED' }),
      );
      expect(completed.items.map((item) => item.student.userId)).toEqual(['s00']);
      const active = expectOk(await h.students.execute({ principal: admin, halaqaId: halaqa.id }));
      expect(active.items.map((item) => item.student.userId)).toEqual(['s01']);
      expect(
        expectErr(
          await h.students.execute({ principal: admin, halaqaId: halaqa.id, status: 'ALL' }),
        ).code,
      ).toBe('academic.status_filter_invalid');
      expect(
        expectErr(
          await h.students.execute({
            principal: admin,
            halaqaId: halaqa.id,
            cursor: 'not-a-cursor',
          }),
        ).code,
      ).toBe('academic.cursor_invalid');
    });

    it('still show an account identity no longer knows — as a gap, never as an error', async () => {
      await h.enrollIn(admin, 's00', halaqa.id);
      h.directory.forget('s00');
      const page = expectOk(await h.students.execute({ principal: admin, halaqaId: halaqa.id }));
      expect(page.items[0]?.student).toEqual({ userId: 's00', displayName: null, active: false });
    });
  });

  describe('my academic record at scale', () => {
    it('is empty, not an error, for someone with no relationship yet', async () => {
      const me = expectOk(await h.me.execute({ principal: student }));
      expect(me).toEqual({ enrollments: [], teaching: [], truncated: false });
    });

    it('lists active relationships up to the bound and says when there are more', async () => {
      const bound = AcademicLimits.myActiveRelationships;
      const program = await h.repository.programByCode('prog-hifz-city');
      if (program === null) throw new Error('seed');
      for (let n = 1; n <= bound + 1 - 45; n++) {
        expectOk(
          await h.createHalaqa.execute({
            principal: admin,
            programId: program.id,
            code: `bound-h${n}`,
            name: `حلقة ${n}`,
            order: n,
            meta: META,
          }),
        );
      }
      const catalogue = await h.readModel.catalogue();
      const halaqat = (
        await Promise.all(catalogue.programs.map((p) => h.readModel.halaqatOf(p.id)))
      ).flat();
      expect(halaqat).toHaveLength(bound + 1);
      for (const halaqa of halaqat) await h.enrollIn(admin, 'student', halaqa.id);
      h.directory.calls.length = 0;

      const me = expectOk(await h.me.execute({ principal: student }));
      expect(me.enrollments).toHaveLength(bound);
      expect(me.truncated).toBe(true);
      expect(h.directory.calls).toEqual([]); // no teachers to name: identity is not asked
    });

    it('answers "who teaches my halaqat" with one read for all of them and one directory call', async () => {
      const learner = h.person('learner', ['STUDENT']);
      h.person('t1', ['TEACHER'], { displayName: 'المعلمة 1' });
      h.person('t2', ['TEACHER'], { displayName: 'المعلمة 2' });
      const first = await h.halaqa('dep-literacy-h1');
      const other = await h.halaqa('dep-letters-h1');
      await h.enrollIn(admin, 'learner', first.id);
      h.clock.advance(1);
      await h.enrollIn(admin, 'learner', other.id);
      await h.assignTo(admin, 't1', first.id);
      await h.assignTo(admin, 't2', other.id);
      h.directory.calls.length = 0;

      const mine = expectOk(await h.me.execute({ principal: learner }));
      expect(mine.enrollments.map((e) => e.teachers.map((t) => t.displayName))).toEqual([
        ['المعلمة 1'],
        ['المعلمة 2'],
      ]);
      expect(h.directory.calls).toEqual([{ method: 'describe', ids: 2 }]);
    });
  });
});

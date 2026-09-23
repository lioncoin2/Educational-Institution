import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  academicHarness,
  type AcademicHarness,
} from '../../../../test/support/academic-harness';
import type { Principal } from '../../../shared';
import { AcademicLimits } from '../domain/academic-policy';

describe('academic structure', () => {
  let h: AcademicHarness;
  let admin: Principal;
  let owner: Principal;
  let teacher: Principal;
  let student: Principal;
  let supervisor: Principal;

  beforeEach(() => {
    h = academicHarness();
    admin = h.person('admin', ['ADMIN']);
    owner = h.person('owner', ['OWNER']);
    teacher = h.person('teacher', ['TEACHER']);
    student = h.person('student', ['STUDENT']);
    supervisor = h.person('supervisor', ['SUPERVISOR']);
  });

  async function newSection(principal = admin, code = 'tajweed-extra', order = 20) {
    return h.createSection.execute({
      principal,
      code,
      name: 'قسم تجريبي',
      kind: 'SPECIAL',
      order,
      meta: META,
    });
  }

  describe('sections', () => {
    it('are created ACTIVE by an academic administrator, audited and announced', async () => {
      const section = expectOk(await newSection());
      expect(section).toMatchObject({ code: 'tajweed-extra', status: 'ACTIVE', kind: 'SPECIAL' });
      expect(h.audit.last('academic.section.created')).toMatchObject({
        actorUserId: 'admin',
        resourceType: 'academic.section',
        resourceId: section.id,
        metadata: { code: 'tajweed-extra', kind: 'SPECIAL' },
        correlationId: 'test-request',
      });
      expect(h.events.published).toEqual([
        expect.objectContaining({
          name: 'academic.section.created',
          aggregateId: section.id,
          payload: {
            sectionId: section.id,
            code: 'tajweed-extra',
            kind: 'SPECIAL',
            status: 'ACTIVE',
          },
        }),
      ]);
    });

    it('may be created by the owner too — and by no teacher, student or supervisor', async () => {
      expect(expectOk(await newSection(owner, 'owner-made')).code).toBe('owner-made');
      for (const principal of [teacher, student, supervisor]) {
        expect(expectErr(await newSection(principal, 'not-allowed')).kind).toBe('forbidden');
      }
      expect(h.events.published).toHaveLength(1);
    });

    it('keep codes unique, and refuse a code shaped like a name', async () => {
      expectOk(await newSection());
      expect(expectErr(await newSection(admin, 'tajweed-extra')).code).toBe('academic.code_taken');
      expect(expectErr(await newSection(admin, 'قسم جديد')).code).toBe('academic.code_invalid');
    });

    it('activate and deactivate explicitly — a repeat changes and records nothing', async () => {
      const section = expectOk(await newSection());
      const off = expectOk(
        await h.sectionStatus.execute({
          principal: admin,
          sectionId: section.id,
          status: 'INACTIVE',
          meta: META,
        }),
      );
      expect(off.status).toBe('INACTIVE');
      const again = expectOk(
        await h.sectionStatus.execute({
          principal: admin,
          sectionId: section.id,
          status: 'INACTIVE',
          meta: META,
        }),
      );
      expect(again.status).toBe('INACTIVE');
      const on = expectOk(
        await h.sectionStatus.execute({
          principal: admin,
          sectionId: section.id,
          status: 'ACTIVE',
          meta: META,
        }),
      );
      expect(on.status).toBe('ACTIVE');
      expect(h.audit.actions()).toEqual([
        'academic.section.created',
        'academic.section.deactivated',
        'academic.section.activated',
      ]);
      expect(h.events.published.map((event) => event.name)).toEqual([
        'academic.section.created',
        'academic.section.deactivated',
        'academic.section.activated',
      ]);
    });

    it('are edited field by field; the audit and the event name the fields, never the values', async () => {
      const section = expectOk(await newSection());
      const edited = expectOk(
        await h.updateSection.execute({
          principal: admin,
          sectionId: section.id,
          change: { name: 'قسم مُعاد تسميته', description: 'وصف جديد' },
          meta: META,
        }),
      );
      expect(edited).toMatchObject({ name: 'قسم مُعاد تسميته', description: 'وصف جديد' });
      expect(h.audit.last('academic.section.updated')?.metadata).toEqual({
        changed: ['name', 'description'],
      });
      expect(h.recorded()).not.toContain('قسم مُعاد تسميته');
    });

    it('report "no such section" for an unknown id', async () => {
      const missing = await h.updateSection.execute({
        principal: admin,
        sectionId: 'nope',
        change: { name: 'x' },
        meta: META,
      });
      expect(expectErr(missing)).toEqual(
        expect.objectContaining({ code: 'academic.section_not_found', kind: 'not_found' }),
      );
    });

    it(`are capped at ${AcademicLimits.maxSections} — a technical bound on the catalogue`, async () => {
      for (let i = 0; i < AcademicLimits.maxSections; i++) {
        expectOk(await newSection(admin, `section-${i}`, i + 1));
      }
      expect(expectErr(await newSection(admin, 'one-too-many'))).toEqual(
        expect.objectContaining({
          code: 'academic.too_many_sections',
          kind: 'precondition_failed',
        }),
      );
    });
  });

  describe('programs', () => {
    it('belong to exactly one existing section', async () => {
      const section = expectOk(await newSection());
      const program = expectOk(
        await h.createProgram.execute({
          principal: admin,
          sectionId: section.id,
          code: 'extra-program',
          name: 'برنامج',
          order: 1,
          meta: META,
        }),
      );
      expect(program).toMatchObject({ sectionId: section.id, activeHalaqaCount: 0 });
      const orphan = await h.createProgram.execute({
        principal: admin,
        sectionId: 'no-such-section',
        code: 'orphan',
        name: 'يتيم',
        order: 1,
        meta: META,
      });
      expect(expectErr(orphan).code).toBe('academic.section_not_found');
      expect(h.events.published.map((e) => e.name)).toEqual([
        'academic.section.created',
        'academic.program.created',
      ]);
    });

    it('activate and deactivate explicitly, counting their active halaqat', async () => {
      await h.seedProfile();
      const program = await h.repository.programByCode('dep-literacy-program');
      if (program === null) throw new Error('seed');
      const off = expectOk(
        await h.programStatus.execute({
          principal: admin,
          programId: program.id,
          status: 'INACTIVE',
          meta: META,
        }),
      );
      expect(off).toMatchObject({ status: 'INACTIVE', activeHalaqaCount: 5 });
      expect(h.audit.last('academic.program.deactivated')?.resourceId).toBe(program.id);
    });
  });

  describe('halaqat', () => {
    it('belong to exactly one existing program', async () => {
      await h.seedProfile();
      const program = await h.repository.programByCode('prog-mutun');
      if (program === null) throw new Error('seed');
      const halaqa = expectOk(
        await h.createHalaqa.execute({
          principal: admin,
          programId: program.id,
          code: 'mutun-jazariyya-1',
          name: 'حلقة الجزرية',
          order: 1,
          meta: META,
        }),
      );
      expect(halaqa).toMatchObject({ programId: program.id, status: 'ACTIVE' });
      const orphan = await h.createHalaqa.execute({
        principal: admin,
        programId: 'no-such-program',
        code: 'orphan-halaqa',
        name: 'يتيمة',
        order: 1,
        meta: META,
      });
      expect(expectErr(orphan).code).toBe('academic.program_not_found');
    });

    it('are renamed without touching their code', async () => {
      await h.seedProfile();
      const halaqa = await h.halaqa('dep-literacy-h1');
      const renamed = expectOk(
        await h.updateHalaqa.execute({
          principal: admin,
          halaqaId: halaqa.id,
          change: { name: 'حلقة الفجر' },
          meta: META,
        }),
      );
      expect(renamed).toMatchObject({ name: 'حلقة الفجر', code: 'dep-literacy-h1' });
    });

    it('may not be deactivated while students are actively enrolled in them', async () => {
      await h.seedProfile();
      h.person('amina', ['STUDENT']);
      const halaqa = await h.halaqa('dep-literacy-h2');
      const enrollment = await h.enrollIn(admin, 'amina', halaqa.id);

      const refused = await h.halaqaStatus.execute({
        principal: admin,
        halaqaId: halaqa.id,
        status: 'INACTIVE',
        meta: META,
      });
      expect(expectErr(refused)).toEqual(
        expect.objectContaining({
          code: 'academic.halaqa_has_active_enrollments',
          kind: 'precondition_failed',
        }),
      );
      expect((await h.repository.findHalaqa(halaqa.id))?.status).toBe('ACTIVE');

      expectOk(
        await h.endEnrollment.execute({
          principal: admin,
          enrollmentId: enrollment.id,
          outcome: 'WITHDRAWN',
          meta: META,
        }),
      );
      const closed = expectOk(
        await h.halaqaStatus.execute({
          principal: admin,
          halaqaId: halaqa.id,
          status: 'INACTIVE',
          meta: META,
        }),
      );
      expect(closed.status).toBe('INACTIVE');
    });

    it('keep their teacher assignments when deactivated — ending those is a separate act', async () => {
      await h.seedProfile();
      h.person('ustadha', ['TEACHER']);
      const halaqa = await h.halaqa('dep-letters-h1');
      await h.assignTo(admin, 'ustadha', halaqa.id);
      expectOk(
        await h.halaqaStatus.execute({
          principal: admin,
          halaqaId: halaqa.id,
          status: 'INACTIVE',
          meta: META,
        }),
      );
      expect(await h.relationships.isTeaching('ustadha', halaqa.id)).toBe(true);
    });
  });
});

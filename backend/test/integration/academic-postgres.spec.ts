import { sql } from 'drizzle-orm';

import type { Principal } from '../../src/shared';
import { STRUCTURE_SEEDER } from '../../src/modules/academic/application/seed-structure.use-case';
import { AcademicLimits } from '../../src/modules/academic/domain/academic-policy';
import { newEnrollment } from '../../src/modules/academic/domain/enrollment';
import {
  createHalaqa,
  createProgram,
  createSection,
  type Halaqa,
  type ProgramId,
} from '../../src/modules/academic/domain/structure';
import { DrizzleAcademicReadModel } from '../../src/modules/academic/infrastructure/drizzle-academic-read-model';
import { DrizzleAcademicRepository } from '../../src/modules/academic/infrastructure/drizzle-academic-repository';
import { META, academicHarness, type AcademicHarness } from '../support/academic-harness';
import { expectErr, expectOk } from '../support/identity-harness';
import {
  describeWithPostgres,
  migrateTo,
  scratchDatabase,
  type ScratchDatabase,
} from '../support/postgres';

const ACADEMIC_TABLES = [
  'academic_sections',
  'academic_programs',
  'academic_halaqat',
  'academic_teacher_assignments',
  'academic_enrollments',
] as const;

/**
 * Academic on Postgres: the invariants the database is trusted with — one
 * ACTIVE enrollment per student and halaqa, one ACTIVE assignment per teacher
 * and halaqa, no enrollment slipping into a halaqa as it closes, caps under
 * contention, history that cannot be deleted from under its references —
 * each asserted against the real engine, through the real adapters and the
 * same use cases the application runs.
 */
describeWithPostgres('academic on Postgres', () => {
  let scratch: ScratchDatabase;
  let h: AcademicHarness;
  let admin: Principal;

  const rows = async <T>(query: ReturnType<typeof sql>) =>
    (await scratch.db.execute(query)).rows as T[];

  /** The name of the constraint a statement violates, or null if it succeeded. */
  async function violated(statement: ReturnType<typeof sql>): Promise<string | null> {
    try {
      await scratch.db.execute(statement);
      return null;
    } catch (error) {
      for (let e: unknown = error; e !== undefined && e !== null;) {
        const candidate = e as { constraint?: string; cause?: unknown };
        if (typeof candidate.constraint === 'string') return candidate.constraint;
        e = candidate.cause;
      }
      throw error;
    }
  }

  beforeAll(async () => {
    scratch = await scratchDatabase();
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await scratch.db.execute(sql`truncate ${sql.raw(ACADEMIC_TABLES.join(', '))}`);
    h = academicHarness({
      repository: new DrizzleAcademicRepository(scratch.db),
      readModel: new DrizzleAcademicReadModel(scratch.db),
    });
    admin = h.person('admin', ['ADMIN']);
    await h.seedProfile();
  });

  describe('the schema the migration built', () => {
    it('has every constraint and index the design relies on, by name', async () => {
      const constraints = await rows<{ conname: string }>(sql`
        select conname from pg_constraint
        where conrelid = any (array[${sql.raw(ACADEMIC_TABLES.map((t) => `'${t}'::regclass`).join(', '))}])`);
      expect(constraints.map((c) => c.conname)).toEqual(
        expect.arrayContaining([
          'academic_sections_code_unique',
          'academic_sections_code_shape',
          'academic_sections_kind_valid',
          'academic_sections_status_valid',
          'academic_programs_code_unique',
          'academic_programs_section_id_academic_sections_id_fk',
          'academic_halaqat_code_unique',
          'academic_halaqat_program_id_academic_programs_id_fk',
          'academic_halaqat_order_range',
          'academic_enrollments_status_valid',
          'academic_enrollments_ended_consistent',
          'academic_enrollments_ended_after_enrolled',
          'academic_enrollments_halaqa_id_academic_halaqat_id_fk',
          'academic_teacher_assignments_role_valid',
          'academic_teacher_assignments_ended_consistent',
          'academic_teacher_assignments_halaqa_id_academic_halaqat_id_fk',
        ]),
      );
      const indexes = await rows<{ indexname: string; indexdef: string }>(sql`
        select indexname, indexdef from pg_indexes where tablename like 'academic_%'`);
      const def = (name: string) => indexes.find((i) => i.indexname === name)?.indexdef ?? '';
      expect(def('academic_enrollments_active_unique')).toMatch(
        /UNIQUE INDEX .*\(student_user_id, halaqa_id\) WHERE \(status = 'ACTIVE'::text\)/u,
      );
      expect(def('academic_teacher_assignments_active_unique')).toMatch(
        /UNIQUE INDEX .*\(halaqa_id, teacher_user_id\) WHERE \(status = 'ACTIVE'::text\)/u,
      );
      expect(indexes.map((i) => i.indexname)).toEqual(
        expect.arrayContaining([
          'academic_enrollments_halaqa_idx',
          'academic_enrollments_student_idx',
          'academic_teacher_assignments_halaqa_idx',
          'academic_teacher_assignments_teacher_idx',
          'academic_programs_section_idx',
          'academic_halaqat_program_idx',
        ]),
      );
    });

    it('keys only to its own tables, RESTRICT on delete — and never to an account', async () => {
      const foreign = await rows<{ source: string; target: string; on_delete: string }>(sql`
        select conrelid::regclass::text as source, confrelid::regclass::text as target,
               confdeltype::text as on_delete
        from pg_constraint
        where contype = 'f' and (conrelid::regclass::text like 'academic_%'
                                 or confrelid::regclass::text like 'academic_%')
        order by source`);
      expect(foreign).toEqual([
        { source: 'academic_enrollments', target: 'academic_halaqat', on_delete: 'r' },
        { source: 'academic_halaqat', target: 'academic_programs', on_delete: 'r' },
        { source: 'academic_programs', target: 'academic_sections', on_delete: 'r' },
        { source: 'academic_teacher_assignments', target: 'academic_halaqat', on_delete: 'r' },
      ]);
    });

    it('refuses what the domain would never write — even without the adapter', async () => {
      const [program] = await rows<{ id: string }>(
        sql`select id from academic_programs where code = 'dep-literacy-program'`,
      );
      const programId = program?.id ?? '';
      const halaqa = await h.halaqa('dep-literacy-h1');
      const halaqaColumns = sql.raw(
        '(id, code, program_id, name, sort_order, status, created_at, updated_at)',
      );
      expect(
        await violated(sql`insert into academic_halaqat ${halaqaColumns}
          values ('x1', 'Upper Case', ${programId}, 'ح', 1, 'ACTIVE', now(), now())`),
      ).toBe('academic_halaqat_code_shape');
      expect(
        await violated(sql`insert into academic_halaqat ${halaqaColumns}
          values ('x2', 'dep-literacy-h1', ${programId}, 'ح', 1, 'ACTIVE', now(), now())`),
      ).toBe('academic_halaqat_code_unique');
      expect(
        await violated(sql`insert into academic_halaqat ${halaqaColumns}
          values ('x3', 'fine-code', ${programId}, 'ح', 0, 'ACTIVE', now(), now())`),
      ).toBe('academic_halaqat_order_range');
      expect(
        await violated(sql`insert into academic_halaqat ${halaqaColumns}
          values ('x4', 'orphan', 'no-such-program', 'ح', 1, 'ACTIVE', now(), now())`),
      ).toBe('academic_halaqat_program_id_academic_programs_id_fk');
      expect(
        await violated(sql`insert into academic_sections
          (id, code, name, kind, sort_order, status, created_at, updated_at)
          values ('x5', 'invented', 'قسم', 'DEPARTMENT', 1, 'ACTIVE', now(), now())`),
      ).toBe('academic_sections_kind_valid');

      const enrollmentColumns = sql.raw(
        '(id, student_user_id, halaqa_id, status, enrolled_at, ended_at, created_at, updated_at)',
      );
      expect(
        await violated(sql`insert into academic_enrollments ${enrollmentColumns}
          values ('e1', 'u', ${halaqa.id}, 'COMPLETED', now(), null, now(), now())`),
      ).toBe('academic_enrollments_ended_consistent');
      expect(
        await violated(sql`insert into academic_enrollments ${enrollmentColumns}
          values ('e2', 'u', ${halaqa.id}, 'ACTIVE', now(), now(), now(), now())`),
      ).toBe('academic_enrollments_ended_consistent');
      expect(
        await violated(sql`insert into academic_enrollments ${enrollmentColumns}
          values ('e3', 'u', ${halaqa.id}, 'WITHDRAWN', now(), now() - interval '1 day', now(), now())`),
      ).toBe('academic_enrollments_ended_after_enrolled');
      expect(
        await violated(sql`insert into academic_enrollments ${enrollmentColumns}
          values ('e4', 'u', ${halaqa.id}, 'SUSPENDED', now(), now(), now(), now())`),
      ).toBe('academic_enrollments_status_valid');
      expect(
        await violated(sql`insert into academic_enrollments ${enrollmentColumns} values
          ('e5', 'u', ${halaqa.id}, 'ACTIVE', now(), null, now(), now()),
          ('e6', 'u', ${halaqa.id}, 'ACTIVE', now(), null, now(), now())`),
      ).toBe('academic_enrollments_active_unique');
      expect(
        await violated(sql`insert into academic_teacher_assignments
          (id, halaqa_id, teacher_user_id, role, status, started_at, created_at)
          values ('t1', ${halaqa.id}, 't', 'HEAD_TEACHER', 'ACTIVE', now(), now())`),
      ).toBe('academic_teacher_assignments_role_valid');
    });

    it('will not delete what history refers to', async () => {
      const halaqa = await h.halaqa('dep-letters-h1');
      h.person('student', ['STUDENT']);
      const enrollment = await h.enrollIn(admin, 'student', halaqa.id);
      expectOk(
        await h.endEnrollment.execute({
          principal: admin,
          enrollmentId: enrollment.id,
          outcome: 'COMPLETED',
          meta: META,
        }),
      );
      expect(await violated(sql`delete from academic_halaqat where id = ${halaqa.id}`)).toBe(
        'academic_enrollments_halaqa_id_academic_halaqat_id_fk',
      );
      expect(
        await violated(sql`delete from academic_programs where code = 'dep-letters-program'`),
      ).toBe('academic_halaqat_program_id_academic_programs_id_fk');
      expect(await violated(sql`delete from academic_sections where code = 'dep-letters'`)).toBe(
        'academic_programs_section_id_academic_sections_id_fk',
      );
    });
  });

  describe('seeding', () => {
    it('writes the profile’s structure once — a second run finds it all', async () => {
      const counts = async () =>
        rows<{ sections: number; programs: number; halaqat: number }>(sql`
          select (select count(*)::int from academic_sections) as sections,
                 (select count(*)::int from academic_programs) as programs,
                 (select count(*)::int from academic_halaqat) as halaqat`);
      expect(await counts()).toEqual([{ sections: 9, programs: 9, halaqat: 45 }]);
      expect(expectOk(await h.seed.execute({ principal: STRUCTURE_SEEDER, meta: META }))).toEqual({
        sections: { created: 0, existing: 9 },
        programs: { created: 0, existing: 9 },
        halaqat: { created: 0, existing: 45 },
      });
      expect(await counts()).toEqual([{ sections: 9, programs: 9, halaqat: 45 }]);
      expect(
        await rows(sql`select count(*)::int as n from academic_enrollments
                       union all select count(*)::int from academic_teacher_assignments`),
      ).toEqual([{ n: 0 }, { n: 0 }]);
    });

    it('keeps what an administrator changed since, and runs concurrently without duplicates', async () => {
      const section = await h.repository.sectionByCode('sec-languages');
      if (section === null) throw new Error('seed');
      expectOk(
        await h.updateSection.execute({
          principal: admin,
          sectionId: section.id,
          change: { name: 'قسم اللغات (معدل)' },
          meta: META,
        }),
      );
      await scratch.db.execute(sql`delete from academic_halaqat where code = 'dep-tajweed-3-h10'`);
      const reports = await Promise.all(
        Array.from({ length: 4 }, () =>
          h.seed.execute({ principal: STRUCTURE_SEEDER, meta: META }),
        ),
      );
      expect(reports.map((report) => expectOk(report).halaqat.created).sort()).toEqual([
        0, 0, 0, 1,
      ]);
      expect((await h.repository.findSection(section.id))?.name).toBe('قسم اللغات (معدل)');
      const [total] = await rows<{ n: number }>(
        sql`select count(*)::int as n from academic_halaqat`,
      );
      expect(total?.n).toBe(45);
    });
  });

  describe('under concurrency', () => {
    let halaqa: Halaqa;

    beforeEach(async () => {
      halaqa = await h.halaqa('dep-tajweed-1-h1');
      h.person('student', ['STUDENT']);
      h.person('teacher', ['TEACHER']);
    });

    it('twenty simultaneous enrollments of one student in one halaqa make one row, audited once', async () => {
      h.audit.entries.length = 0;
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          h.enroll.execute({
            principal: admin,
            halaqaId: halaqa.id,
            studentUserId: 'student',
            meta: META,
          }),
        ),
      );
      const values = results.map((result) => expectOk(result));
      expect(values.filter((value) => value.created)).toHaveLength(1);
      expect(new Set(values.map((value) => value.enrollment.id)).size).toBe(1);
      expect(
        await rows(sql`select count(*)::int as n from academic_enrollments
                       where student_user_id = 'student' and halaqa_id = ${halaqa.id}`),
      ).toEqual([{ n: 1 }]);
      expect(h.audit.actions()).toEqual(['academic.student.enrolled']);
    });

    it('simultaneous assignments of one teacher to one halaqa make one ACTIVE row', async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          h.assign.execute({
            principal: admin,
            halaqaId: halaqa.id,
            teacherUserId: 'teacher',
            role: i % 2 === 0 ? 'TEACHER' : 'ASSISTANT_TEACHER',
            meta: META,
          }),
        ),
      );
      const created = results.filter((result) => result.ok && result.value.created);
      expect(created).toHaveLength(1);
      // Everyone else found it — or asked for the other role and was refused.
      for (const result of results) {
        if (!result.ok) expect(result.error.code).toBe('academic.teacher_already_assigned');
      }
      expect(
        await rows(sql`select count(*)::int as n from academic_teacher_assignments
                       where teacher_user_id = 'teacher' and status = 'ACTIVE'`),
      ).toEqual([{ n: 1 }]);
    });

    it('ends an enrollment exactly once when two administrators end it at the same moment', async () => {
      const enrollment = await h.enrollIn(admin, 'student', halaqa.id);
      h.audit.entries.length = 0;
      const results = await Promise.all(
        (['COMPLETED', 'WITHDRAWN'] as const).map((outcome) =>
          h.endEnrollment.execute({
            principal: admin,
            enrollmentId: enrollment.id,
            outcome,
            meta: META,
          }),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const refused = results.find((result) => !result.ok);
      if (refused === undefined) throw new Error('both administrators ended it');
      expect(expectErr(refused).code).toBe('academic.enrollment_already_ended');
      expect(h.audit.actions()).toEqual(['academic.student.enrollment_ended']);
    });

    it('never leaves an ACTIVE enrollment in a halaqa closed at the same moment', async () => {
      const program = await h.repository.programByCode('prog-nahw');
      if (program === null) throw new Error('seed');
      const winners: string[] = [];
      for (let round = 0; round < 25; round++) {
        const created = expectOk(
          await h.createHalaqa.execute({
            principal: admin,
            programId: program.id,
            code: `race-${round}`,
            name: `حلقة ${round}`,
            order: round + 1,
            meta: META,
          }),
        );
        const [enrolled, closed] = await Promise.all([
          h.enroll.execute({
            principal: admin,
            halaqaId: created.id,
            studentUserId: 'student',
            meta: META,
          }),
          h.halaqaStatus.execute({
            principal: admin,
            halaqaId: created.id,
            status: 'INACTIVE',
            meta: META,
          }),
        ]);
        // Exactly one of them wins; the other is told why.
        expect([enrolled.ok, closed.ok].filter(Boolean)).toHaveLength(1);
        if (enrolled.ok) {
          expect(expectErr(closed).code).toBe('academic.halaqa_has_active_enrollments');
          winners.push('enrollment');
        } else {
          expect(enrolled.error.code).toBe('academic.halaqa_inactive');
          winners.push('closing');
        }
      }
      expect(
        await rows(sql`select count(*)::int as n from academic_enrollments e
                       join academic_halaqat h on h.id = e.halaqa_id
                       where e.status = 'ACTIVE' and h.status = 'INACTIVE'`),
      ).toEqual([{ n: 0 }]);
      expect(winners).toHaveLength(25);
    }, 60_000);

    it('keeps a cap under contention, and one code to one row', async () => {
      const section = createSection({
        id: h.ids.next<'AcademicSection'>(),
        code: 'contended',
        name: 'قسم',
        kind: 'SPECIAL',
        order: 99,
        description: null,
        at: h.clock.now(),
      });
      if (!section.ok) throw new Error('fixture');
      expect((await h.repository.createSection(section.value, 50)).kind).toBe('created');
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_, i) => {
          const program = createProgram({
            id: h.ids.next<'AcademicProgram'>(),
            sectionId: section.value.id,
            code: `contended-${i}`,
            name: 'برنامج',
            order: i + 1,
            description: null,
            at: h.clock.now(),
          });
          if (!program.ok) throw new Error('fixture');
          return h.repository.createProgram(program.value, 3);
        }),
      );
      expect(outcomes.filter((o) => o.kind === 'created')).toHaveLength(3);
      expect(outcomes.filter((o) => o.kind === 'limit_reached')).toHaveLength(5);

      // Which three of the eight won the race is not fixed, so take one that
      // exists rather than assuming `contended-0` was among them.
      const created = await rows<{ id: ProgramId }>(
        sql`select id from academic_programs where section_id = ${section.value.id} order by code`,
      );
      expect(created).toHaveLength(3);
      const [program] = created;
      const sameCode = await Promise.all(
        Array.from({ length: 6 }, () => {
          const halaqa = createHalaqa({
            id: h.ids.next<'AcademicHalaqa'>(),
            programId: program?.id ?? ('' as ProgramId),
            code: 'one-code',
            name: 'حلقة',
            order: 1,
            at: h.clock.now(),
          });
          if (!halaqa.ok) throw new Error('fixture');
          return h.repository.createHalaqa(halaqa.value, AcademicLimits.maxHalaqatPerProgram);
        }),
      );
      expect(sameCode.map((o) => o.kind).sort()).toEqual([
        'code_taken',
        'code_taken',
        'code_taken',
        'code_taken',
        'code_taken',
        'created',
      ]);
    });
  });

  describe('history and pages', () => {
    it('keeps every enrollment a student ever had, newest first, a page at a time', async () => {
      h.person('student', ['STUDENT']);
      const halaqa = await h.halaqa('dep-literacy-h2');
      for (let i = 0; i < 45; i++) {
        const enrollment = await h.enrollIn(admin, 'student', halaqa.id);
        h.clock.advance(60);
        expectOk(
          await h.endEnrollment.execute({
            principal: admin,
            enrollmentId: enrollment.id,
            outcome: i % 2 === 0 ? 'COMPLETED' : 'WITHDRAWN',
            meta: META,
          }),
        );
      }
      const current = await h.enrollIn(admin, 'student', halaqa.id);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = expectOk(
          await h.studentEnrollments.execute({
            principal: admin,
            studentUserId: 'student',
            limit: 20,
            cursor,
          }),
        );
        seen.push(...page.items.map((item) => item.enrollment.id));
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor !== undefined);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(46);
      expect(new Set(seen).size).toBe(46);
      expect(seen[0]).toBe(current.id);
    });

    it('reads rosters, histories and "who teaches here" from the indexes built for them', async () => {
      const halaqa = await h.halaqa('dep-tajweed-2-h1');
      for (let i = 0; i < 300; i++) {
        await h.repository.enroll(
          newEnrollment({
            id: h.ids.next<'AcademicEnrollment'>(),
            studentUserId: `bulk-${i}`,
            halaqaId: halaqa.id,
            enrolledBy: 'admin',
            at: h.clock.now(),
          }),
        );
      }
      await scratch.db.execute(sql`analyze academic_enrollments`);
      await scratch.db.execute(sql`analyze academic_teacher_assignments`);

      const plan = (query: ReturnType<typeof sql>) =>
        scratch.db.transaction(async (tx) => {
          // What matters is that the index exists and serves the query; on
          // tables this small the planner may rightly prefer a scan.
          await tx.execute(sql`set local enable_seqscan = off`);
          return JSON.stringify((await tx.execute(sql`explain (format json) ${query}`)).rows);
        });

      const roster = await plan(sql`
        select * from academic_enrollments
        where halaqa_id = ${halaqa.id} and status = 'ACTIVE'
          and (enrolled_at, id) > (now() - interval '1 year', '')
        order by enrolled_at, id limit 51`);
      expect(roster).toContain('academic_enrollments_halaqa_idx');
      expect(roster).not.toContain('"Node Type":"Sort"');

      const history = await plan(sql`
        select * from academic_enrollments
        where student_user_id = 'bulk-7' and (enrolled_at, id) < (now() + interval '1 day', 'zzz')
        order by enrolled_at desc, id desc limit 21`);
      expect(history).toContain('academic_enrollments_student_idx');

      const teaching = await plan(sql`
        select id from academic_teacher_assignments
        where halaqa_id = ${halaqa.id} and teacher_user_id = 't' and status = 'ACTIVE' limit 1`);
      expect(teaching).toMatch(/academic_teacher_assignments_(active_unique|halaqa_idx)/u);

      const assignments = await plan(sql`
        select * from academic_teacher_assignments
        where teacher_user_id = 't' order by started_at desc, id desc limit 21`);
      expect(assignments).toContain('academic_teacher_assignments_teacher_idx');

      const enrolled = await plan(sql`
        select id from academic_enrollments
        where student_user_id = 'bulk-7' and halaqa_id = ${halaqa.id} and status = 'ACTIVE' limit 1`);
      expect(enrolled).toMatch(/academic_enrollments_(active_unique|halaqa_idx|student_idx)/u);
    }, 60_000);
  });
});

describeWithPostgres('migrations 0007–0008 on a database already in use', () => {
  let scratch: ScratchDatabase;

  beforeAll(async () => {
    scratch = await scratchDatabase({ upTo: 7 });
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  it('add academic’s tables and two permissions without touching what was there', async () => {
    const grants = async () =>
      (
        await scratch.db.execute(
          sql`select role_code || ':' || permission_code as grant from role_permissions order by 1`,
        )
      ).rows.map((row) => row.grant as string);
    const before = await grants();
    await scratch.db.execute(sql`
      insert into users (id, display_name, status, password_hash, password_changed_at, created_at, updated_at)
      values ('u-kept', 'باقٍ', 'ACTIVE', '$scrypt$16384$8$1$c2FsdA==$aGFzaA==', now(), now(), now())`);

    await migrateTo(scratch.db);

    const after = await grants();
    expect(after.filter((grant) => !before.includes(grant))).toEqual([
      'ADMIN:academic.study',
      'ADMIN:academic.teach',
      'ASSISTANT_TEACHER:academic.teach',
      'OWNER:academic.study',
      'OWNER:academic.teach',
      'STUDENT:academic.study',
      'TEACHER:academic.teach',
    ]);
    expect(before.filter((grant) => !after.includes(grant))).toEqual([]);
    const tables = await scratch.db.execute(
      sql`select tablename from pg_tables where tablename like 'academic_%' order by 1`,
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      'academic_enrollments',
      'academic_halaqat',
      'academic_programs',
      'academic_sections',
      'academic_teacher_assignments',
    ]);
    const kept = await scratch.db.execute(sql`select display_name from users where id = 'u-kept'`);
    expect(kept.rows).toEqual([{ display_name: 'باقٍ' }]);
    // The structure is not seeded by a migration: that is an explicit step.
    const [sections] = (
      await scratch.db.execute(sql`select count(*)::int as n from academic_sections`)
    ).rows;
    expect(sections).toEqual({ n: 0 });
  });
});

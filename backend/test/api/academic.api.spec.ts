import type { ApiResponse } from '../support/api-client';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

interface WireProgram {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: string;
  readonly activeHalaqaCount: number;
}

interface WireSection {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly programs: readonly WireProgram[];
}

interface WireHalaqa {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: string;
}

/**
 * Academic over HTTP — the application exactly as the server runs it without
 * a database: the in-memory store, seeded at boot from the institution
 * profile. Postgres, its constraints and concurrency are in
 * test/integration/academic-postgres.spec.ts.
 */
describe('academic API', () => {
  let r: RealtimeApi;
  let admin: Account;
  let teacher: Account;
  let otherTeacher: Account;
  let student: Account;
  let classmate: Account;
  let supervisor: Account;
  /** Every response an /academic route returned — for "never leaks" checks. */
  const academicTranscript: string[] = [];

  beforeAll(async () => {
    r = await startRealtimeApi();
    admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    teacher = await r.provision('teacher', 'TEACHER', 'الأستاذة عائشة');
    otherTeacher = await r.provision('other-teacher', 'TEACHER', 'الأستاذة سودة');
    student = await r.provision('student', 'STUDENT', 'مريم');
    classmate = await r.provision('classmate', 'STUDENT', 'زينب');
    supervisor = await r.provision('supervisor', 'SUPERVISOR', 'المشرفة');
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  async function call(
    method: string,
    path: string,
    account?: Account,
    body?: unknown,
  ): Promise<ApiResponse> {
    const response = await r.api.call(method, `/academic${path}`, {
      token: account?.token,
      body: body ?? (method === 'GET' ? undefined : {}),
    });
    academicTranscript.push(response.raw);
    return response;
  }

  async function catalogue(account: Account = student): Promise<WireSection[]> {
    const response = await call('GET', '/sections', account);
    expect(response.status).toBe(200);
    return response.body.sections as WireSection[];
  }

  async function halaqatOf(programCode: string): Promise<WireHalaqa[]> {
    const program = (await catalogue())
      .flatMap((section) => section.programs)
      .find((p) => p.code === programCode);
    if (program === undefined) throw new Error(`no program ${programCode}`);
    const response = await call('GET', `/programs/${program.id}`, student);
    expect(response.status).toBe(200);
    return response.body.halaqat as WireHalaqa[];
  }

  async function halaqa(code: string): Promise<WireHalaqa> {
    const programCode = `${code.replace(/-h\d+$/u, '')}-program`;
    const found = (await halaqatOf(programCode)).find((h) => h.code === code);
    if (found === undefined) throw new Error(`no halaqa ${code}`);
    return found;
  }

  function errorCode(response: ApiResponse): unknown {
    return (response.body.error as Record<string, unknown> | undefined)?.code;
  }

  it('refuses every academic route to an anonymous caller', async () => {
    const routes = [
      ['GET', '/sections'],
      ['GET', '/sections/x'],
      ['GET', '/programs/x'],
      ['GET', '/halaqat/x'],
      ['POST', '/sections'],
      ['PATCH', '/sections/x'],
      ['POST', '/sections/x/activate'],
      ['POST', '/sections/x/deactivate'],
      ['POST', '/programs'],
      ['PATCH', '/programs/x'],
      ['POST', '/programs/x/activate'],
      ['POST', '/programs/x/deactivate'],
      ['POST', '/halaqat'],
      ['PATCH', '/halaqat/x'],
      ['POST', '/halaqat/x/activate'],
      ['POST', '/halaqat/x/deactivate'],
      ['GET', '/halaqat/x/students'],
      ['POST', '/halaqat/x/enrollments'],
      ['POST', '/enrollments/x/end'],
      ['GET', '/students/x/enrollments'],
      ['GET', '/halaqat/x/teachers'],
      ['POST', '/halaqat/x/teachers'],
      ['POST', '/teacher-assignments/x/end'],
      ['GET', '/teachers/x/assignments'],
      ['GET', '/me'],
      ['GET', '/me/enrollments'],
      ['GET', '/me/teaching'],
    ] as const;
    expect(routes).toHaveLength(27);
    for (const [method, path] of routes) {
      expect([method, path, (await call(method, path)).status]).toEqual([method, path, 401]);
    }
  });

  describe('the structure', () => {
    it('is the institution profile’s, seeded at boot — nine sections, 45 halaqat, in order', async () => {
      const sections = await catalogue();
      expect(sections.map((s) => [s.code, s.kind, s.status])).toEqual([
        ['dep-literacy', 'PROGRESSIVE', 'ACTIVE'],
        ['dep-letters', 'PROGRESSIVE', 'ACTIVE'],
        ['dep-tajweed-1', 'PROGRESSIVE', 'ACTIVE'],
        ['dep-tajweed-2', 'PROGRESSIVE', 'ACTIVE'],
        ['dep-tajweed-3', 'PROGRESSIVE', 'ACTIVE'],
        ['sec-spelling', 'SPECIAL', 'ACTIVE'],
        ['sec-kids', 'SPECIAL', 'ACTIVE'],
        ['sec-languages', 'SPECIAL', 'ACTIVE'],
        ['accompanying', 'ACCOMPANYING', 'ACTIVE'],
      ]);
      const counted = sections
        .flatMap((s) => s.programs)
        .reduce((sum, p) => sum + p.activeHalaqaCount, 0);
      expect(counted).toBe(45);
      expect(sections.find((s) => s.code === 'accompanying')?.programs.map((p) => p.name)).toEqual([
        'مدينة الحفاظ',
        'علوم النحو',
        'المقارئ',
        'المتون',
      ]);
    });

    it('is readable by every role', async () => {
      for (const account of [r.owner, admin, supervisor, teacher, student]) {
        expect(await catalogue(account)).toHaveLength(9);
      }
    });

    it('answers a section, a program with its halaqat, and a halaqa with where it sits', async () => {
      const [literacy] = await catalogue();
      if (literacy === undefined) throw new Error('seed');
      const section = await call('GET', `/sections/${literacy.id}`, student);
      expect(section.status).toBe(200);
      expect(section.body).toMatchObject({
        code: 'dep-literacy',
        programs: [{ code: 'dep-literacy-program' }],
      });
      expect((await halaqatOf('dep-literacy-program')).map((h) => h.name)).toEqual([
        'الحلقة 1',
        'الحلقة 2',
        'الحلقة 3',
        'الحلقة 4',
        'الحلقة 5',
      ]);
      const one = await halaqa('dep-literacy-h3');
      const detail = await call('GET', `/halaqat/${one.id}`, student);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        halaqa: { code: 'dep-literacy-h3', status: 'ACTIVE' },
        program: { code: 'dep-literacy-program' },
        section: { code: 'dep-literacy', kind: 'PROGRESSIVE' },
      });
      const missing = await call('GET', '/halaqat/no-such-halaqa', student);
      expect([missing.status, errorCode(missing)]).toEqual([404, 'academic.halaqa_not_found']);
    });

    it('is changed only by academic administrators — 403 for teachers, students and supervisors', async () => {
      const [literacy] = await catalogue();
      const program = literacy?.programs[0];
      if (literacy === undefined || program === undefined) throw new Error('seed');
      const one = await halaqa('dep-literacy-h1');
      const changes = [
        ['POST', '/sections', { code: 'x-section', name: 'س', kind: 'SPECIAL', order: 30 }],
        ['PATCH', `/sections/${literacy.id}`, { name: 'س' }],
        ['POST', `/sections/${literacy.id}/deactivate`, {}],
        ['POST', '/programs', { code: 'x-program', name: 'س', order: 30, sectionId: literacy.id }],
        ['PATCH', `/programs/${program.id}`, { order: 3 }],
        ['POST', `/programs/${program.id}/deactivate`, {}],
        ['POST', '/halaqat', { code: 'x-halaqa', name: 'س', order: 30, programId: program.id }],
        ['PATCH', `/halaqat/${one.id}`, { name: 'س' }],
        ['POST', `/halaqat/${one.id}/deactivate`, {}],
        ['POST', `/halaqat/${one.id}/enrollments`, { studentUserId: student.id }],
        ['POST', `/halaqat/${one.id}/teachers`, { teacherUserId: teacher.id, role: 'TEACHER' }],
        ['POST', '/enrollments/x/end', { outcome: 'COMPLETED' }],
        ['POST', '/teacher-assignments/x/end', {}],
        ['GET', `/students/${student.id}/enrollments`, undefined],
        ['GET', `/teachers/${teacher.id}/assignments`, undefined],
      ] as const;
      for (const account of [teacher, student, supervisor]) {
        for (const [method, path, body] of changes) {
          expect([method, path, (await call(method, path, account, body)).status]).toEqual([
            method,
            path,
            403,
          ]);
        }
      }
      expect((await catalogue()).map((s) => s.status)).not.toContain('INACTIVE');
    });

    it('creates, edits and deactivates what an administrator asks — 201, 200, and 200 again', async () => {
      const created = await call('POST', '/sections', admin, {
        code: 'api-test-section',
        name: 'قسم للاختبار',
        kind: 'SPECIAL',
        order: 40,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        code: 'api-test-section',
        status: 'ACTIVE',
        description: null,
      });
      const id = created.body.id as string;

      const edited = await call('PATCH', `/sections/${id}`, admin, { name: '  قسم   للتجربة ' });
      expect([edited.status, edited.body.name]).toEqual([200, 'قسم للتجربة']);

      const off = await call('POST', `/sections/${id}/deactivate`, admin);
      expect([off.status, off.body.status]).toEqual([200, 'INACTIVE']);
      const again = await call('POST', `/sections/${id}/deactivate`, admin);
      expect([again.status, again.body.status]).toEqual([200, 'INACTIVE']);
      expect((await catalogue()).find((s) => s.id === id)?.status).toBe('INACTIVE');

      const taken = await call('POST', '/sections', admin, {
        code: 'API-Test-Section',
        name: 'مكرر',
        kind: 'SPECIAL',
        order: 41,
      });
      expect([taken.status, errorCode(taken)]).toEqual([409, 'academic.code_taken']);
    });

    it('refuses what a request may not carry (400) and what the domain does not accept (422)', async () => {
      const smuggled = await call('POST', '/sections', admin, {
        code: 'smuggled',
        name: 'س',
        kind: 'SPECIAL',
        order: 1,
        status: 'INACTIVE',
      });
      expect(smuggled.status).toBe(400);
      const invented = await call('POST', '/sections', admin, {
        code: 'invented',
        name: 'س',
        kind: 'DEPARTMENT',
        order: 1,
      });
      expect(invented.status).toBe(400);
      const [literacy] = await catalogue();
      const reparented = await call('PATCH', `/programs/${literacy?.programs[0]?.id}`, admin, {
        sectionId: 'elsewhere',
      });
      expect(reparented.status).toBe(400);

      const badCode = await call('POST', '/sections', admin, {
        code: 'قسم جديد',
        name: 'س',
        kind: 'SPECIAL',
        order: 1,
      });
      expect([badCode.status, errorCode(badCode)]).toEqual([422, 'academic.code_invalid']);
      const badName = await call('POST', '/sections', admin, {
        code: 'blank-name',
        name: '   ',
        kind: 'SPECIAL',
        order: 1,
      });
      expect([badName.status, errorCode(badName)]).toEqual([422, 'academic.name_invalid']);
      const badOrder = await call('POST', '/sections', admin, {
        code: 'zero-order',
        name: 'س',
        kind: 'SPECIAL',
        order: 0,
      });
      expect([badOrder.status, errorCode(badOrder)]).toEqual([422, 'academic.order_invalid']);
    });
  });

  describe('enrollment and teaching', () => {
    let tajweed: WireHalaqa;
    let neighbour: WireHalaqa;

    beforeAll(async () => {
      tajweed = await halaqa('dep-tajweed-1-h2');
      neighbour = await halaqa('dep-tajweed-1-h3');
    });

    it('enrolls a student — 201, then 200 with the same enrollment when repeated', async () => {
      const first = await call('POST', `/halaqat/${tajweed.id}/enrollments`, admin, {
        studentUserId: student.id,
      });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        enrollment: {
          studentUserId: student.id,
          halaqaId: tajweed.id,
          status: 'ACTIVE',
          endedAt: null,
        },
        placement: {
          section: { code: 'dep-tajweed-1' },
          program: { code: 'dep-tajweed-1-program' },
          halaqa: { code: 'dep-tajweed-1-h2' },
        },
      });
      const repeat = await call('POST', `/halaqat/${tajweed.id}/enrollments`, admin, {
        studentUserId: student.id,
      });
      expect(repeat.status).toBe(200);
      expect(repeat.body.enrollment).toEqual(first.body.enrollment);
      expect(
        (
          await call('POST', `/halaqat/${tajweed.id}/enrollments`, admin, {
            studentUserId: classmate.id,
          })
        ).status,
      ).toBe(201);
    });

    it('assigns a teacher — 201, then 200 — and refuses one who may not teach', async () => {
      const first = await call('POST', `/halaqat/${tajweed.id}/teachers`, admin, {
        teacherUserId: teacher.id,
        role: 'TEACHER',
      });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        teacherUserId: teacher.id,
        role: 'TEACHER',
        status: 'ACTIVE',
      });
      const repeat = await call('POST', `/halaqat/${tajweed.id}/teachers`, admin, {
        teacherUserId: teacher.id,
        role: 'TEACHER',
      });
      expect([repeat.status, repeat.body.id]).toEqual([200, first.body.id]);
      const otherRole = await call('POST', `/halaqat/${tajweed.id}/teachers`, admin, {
        teacherUserId: teacher.id,
        role: 'ASSISTANT_TEACHER',
      });
      expect([otherRole.status, errorCode(otherRole)]).toEqual([
        409,
        'academic.teacher_already_assigned',
      ]);
      expect(
        (
          await call('POST', `/halaqat/${neighbour.id}/teachers`, admin, {
            teacherUserId: otherTeacher.id,
            role: 'TEACHER',
          })
        ).status,
      ).toBe(201);
      const student_ = await call('POST', `/halaqat/${tajweed.id}/teachers`, admin, {
        teacherUserId: student.id,
        role: 'TEACHER',
      });
      expect([student_.status, errorCode(student_)]).toEqual([
        422,
        'academic.teacher_not_eligible',
      ]);
      const invented = await call('POST', `/halaqat/${tajweed.id}/teachers`, admin, {
        teacherUserId: teacher.id,
        role: 'HEAD_TEACHER',
      });
      expect(invented.status).toBe(400);
    });

    it('opens a halaqa’s roster to its own teacher only — by display name, a page at a time', async () => {
      const page = await call('GET', `/halaqat/${tajweed.id}/students?limit=1`, teacher);
      expect(page.status).toBe(200);
      expect(page.body.items).toEqual([
        {
          enrollment: expect.objectContaining({ studentUserId: student.id, status: 'ACTIVE' }),
          student: { userId: student.id, displayName: 'مريم', active: true },
        },
      ]);
      expect(page.body.nextCursor).toEqual(expect.any(String));
      const next = await call(
        'GET',
        `/halaqat/${tajweed.id}/students?limit=1&cursor=${encodeURIComponent(page.body.nextCursor as string)}`,
        teacher,
      );
      expect(next.body).toEqual({
        items: [
          expect.objectContaining({
            student: { userId: classmate.id, displayName: 'زينب', active: true },
          }),
        ],
        nextCursor: null,
      });

      for (const outsider of [otherTeacher, student, classmate, supervisor]) {
        const refused = await call('GET', `/halaqat/${tajweed.id}/students`, outsider);
        expect(refused.status).toBe(403);
      }
      expect((await call('GET', `/halaqat/${neighbour.id}/students`, teacher)).status).toBe(403);
      expect((await call('GET', `/halaqat/${tajweed.id}/teachers`, teacher)).status).toBe(200);
      expect((await call('GET', `/halaqat/${tajweed.id}/students`, admin)).status).toBe(200);
      expect((await call('GET', `/halaqat/${tajweed.id}/students`, r.owner)).status).toBe(200);
    });

    it('shows a student their own halaqa and its teachers — not their classmates', async () => {
      const mine = await call('GET', '/me', student);
      expect(mine.status).toBe(200);
      expect(mine.body).toEqual({
        enrollments: [
          {
            enrollment: expect.objectContaining({
              studentUserId: student.id,
              halaqaId: tajweed.id,
            }),
            placement: expect.objectContaining({
              halaqa: expect.objectContaining({ code: 'dep-tajweed-1-h2' }),
            }),
            teachers: [{ userId: teacher.id, displayName: 'الأستاذة عائشة', role: 'TEACHER' }],
          },
        ],
        teaching: [],
        truncated: false,
      });
      expect(mine.raw).not.toContain(classmate.id);
      expect(mine.raw).not.toContain('زينب');
      expect(mine.raw).not.toContain(admin.id);
    });

    it('shows a teacher what they teach, and no student’s record', async () => {
      const mine = await call('GET', '/me', teacher);
      expect(mine.status).toBe(200);
      expect(mine.body.enrollments).toEqual([]);
      expect(mine.body.teaching).toEqual([
        {
          assignment: expect.objectContaining({ halaqaId: tajweed.id, role: 'TEACHER' }),
          placement: expect.objectContaining({
            program: expect.objectContaining({ code: 'dep-tajweed-1-program' }),
          }),
        },
      ]);
      expect(mine.raw).not.toContain(student.id);
      const history = await call('GET', '/me/teaching', teacher);
      expect((history.body.items as unknown[]).length).toBe(1);
    });

    it('closes enrollment where the structure is closed (412), and keeps an occupied halaqa open', async () => {
      const occupied = await call('POST', `/halaqat/${tajweed.id}/deactivate`, admin);
      expect([occupied.status, errorCode(occupied)]).toEqual([
        412,
        'academic.halaqa_has_active_enrollments',
      ]);
      const off = await call('POST', `/halaqat/${neighbour.id}/deactivate`, admin);
      expect([off.status, off.body.status]).toEqual([200, 'INACTIVE']);
      const closed = await call('POST', `/halaqat/${neighbour.id}/enrollments`, admin, {
        studentUserId: classmate.id,
      });
      expect([closed.status, errorCode(closed)]).toEqual([412, 'academic.halaqa_inactive']);
      expect((await call('POST', `/halaqat/${neighbour.id}/activate`, admin)).status).toBe(200);

      const notAStudent = await call('POST', `/halaqat/${neighbour.id}/enrollments`, admin, {
        studentUserId: teacher.id,
      });
      expect([notAStudent.status, errorCode(notAStudent)]).toEqual([
        422,
        'academic.student_not_eligible',
      ]);
    });

    it('refuses a status or cursor that is not a roster’s own', async () => {
      const all = await call('GET', `/halaqat/${tajweed.id}/students?status=ALL`, admin);
      expect([all.status, errorCode(all)]).toEqual([422, 'academic.status_filter_invalid']);
      const forged = await call('GET', `/halaqat/${tajweed.id}/students?cursor=forged`, admin);
      expect([forged.status, errorCode(forged)]).toEqual([422, 'academic.cursor_invalid']);
      expect((await call('GET', `/halaqat/${tajweed.id}/students?limit=0`, admin)).status).toBe(
        400,
      );
      expect((await call('GET', `/halaqat/${tajweed.id}/students?limit=201`, admin)).status).toBe(
        400,
      );
    });

    it('ends an enrollment once, keeps it as the student’s history, and never rewrites it', async () => {
      const [entry] = (await call('GET', '/me', classmate)).body.enrollments as {
        enrollment: { id: string };
      }[];
      if (entry === undefined) throw new Error('fixture');
      const ended = await call('POST', `/enrollments/${entry.enrollment.id}/end`, admin, {
        outcome: 'WITHDRAWN',
      });
      expect([ended.status, ended.body.status]).toEqual([200, 'WITHDRAWN']);
      expect(ended.body.endedAt).toEqual(expect.any(String));
      expect(
        (
          await call('POST', `/enrollments/${entry.enrollment.id}/end`, admin, {
            outcome: 'WITHDRAWN',
          })
        ).status,
      ).toBe(200);
      const rewrite = await call('POST', `/enrollments/${entry.enrollment.id}/end`, admin, {
        outcome: 'COMPLETED',
      });
      expect([rewrite.status, errorCode(rewrite)]).toEqual([
        409,
        'academic.enrollment_already_ended',
      ]);
      expect(
        (
          await call('POST', `/enrollments/${entry.enrollment.id}/end`, admin, {
            outcome: 'EXPELLED',
          })
        ).status,
      ).toBe(400);

      const history = await call('GET', '/me/enrollments', classmate);
      expect(
        (history.body.items as { enrollment: { status: string } }[]).map(
          (i) => i.enrollment.status,
        ),
      ).toEqual(['WITHDRAWN']);
      expect((await call('GET', '/me', classmate)).body.enrollments).toEqual([]);
      const byAdmin = await call('GET', `/students/${classmate.id}/enrollments`, admin);
      expect(byAdmin.status).toBe(200);
      expect((byAdmin.body.items as unknown[]).length).toBe(1);
    });

    it('closes the roster to a teacher whose assignment ended', async () => {
      const assignments = await call('GET', `/teachers/${teacher.id}/assignments`, admin);
      const [current] = assignments.body.items as { assignment: { id: string } }[];
      if (current === undefined) throw new Error('fixture');
      const ended = await call('POST', `/teacher-assignments/${current.assignment.id}/end`, admin);
      expect([ended.status, ended.body.status]).toEqual([200, 'ENDED']);
      expect((await call('GET', `/halaqat/${tajweed.id}/students`, teacher)).status).toBe(403);
      const mine = await call('GET', '/me', student);
      expect((mine.body.enrollments as { teachers: unknown[] }[])[0]?.teachers).toEqual([]);
    });
  });

  it('never answers with an email, a password or a token', () => {
    const everything = academicTranscript.join('\n');
    expect(academicTranscript.length).toBeGreaterThan(100);
    expect(everything).not.toContain('@');
    expect(everything).not.toContain('passphrase');
    expect(everything.toLowerCase()).not.toContain('password');
    for (const account of [r.owner, admin, teacher, student]) {
      expect(everything).not.toContain(account.token);
      expect(everything).not.toContain(account.refreshToken);
    }
  });
});

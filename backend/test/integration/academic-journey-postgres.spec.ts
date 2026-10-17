import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { startApi, type RunningApi } from '../support/api-client';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

/**
 * The trial's core academic journey, end to end over REAL PostgreSQL, driven by
 * the exact HTTP calls the Flutter app makes (http_admin_repository /
 * http_academic_repository): the actual routes → AccessGuard → use cases across
 * BOTH the identity and academic modules → the Drizzle repositories → response
 * serialization. It is the automated, CI-enforced form of the manual
 * `scripts/trial/local-backend.sh smoke`, and it guards the chain the trial
 * depends on from silently breaking.
 *
 *   OWNER logs in → creates section → program → halaqa
 *   → provisions a TEACHER and a STUDENT (create → role → activate)
 *   → assigns the teacher to the halaqa → enrols the student
 *   → the teacher logs in → GET /academic/me shows the halaqa under `teaching`
 *   → the teacher reads the halaqa roster and sees the student
 *
 * It asserts the response FIELDS the Flutter models parse (not HTTP status
 * alone): `MyAcademic`/`MyTeaching`/`AcademicPlacement` for /academic/me,
 * `HalaqaRosterEntry` for the roster, and the structure/assignment/enrollment
 * shapes the admin and academic repositories read. The authentication contract
 * itself is covered by `identity.api.spec` and is only exercised here as the
 * means to obtain tokens — not re-tested.
 *
 * Booted with `DATABASE_URL` set to a fresh scratch database, so the application
 * composes its Drizzle adapters; isolated per run, dropped afterwards.
 */
describeWithPostgres(
  'academic journey over PostgreSQL (HTTP → Drizzle, as the app drives it)',
  () => {
    const OWNER = { email: 'owner@institution.test', password: 'owner passphrase one' };
    const TEACHER = { email: 'muallim@institution.test', password: 'teacher passphrase one' };
    const STUDENT = { email: 'taalib@institution.test', password: 'student passphrase one' };

    let scratch: ScratchDatabase;
    let api: RunningApi;
    let ownerToken: string;

    // State threaded through the ordered journey below.
    const id: Record<string, string> = {};
    let teacherToken: string;

    const expectKeys = (body: Record<string, unknown>, keys: string[]): void => {
      for (const key of keys) expect(body).toHaveProperty(key);
    };

    async function login(email: string, password: string): Promise<string> {
      const res = await api.call('POST', '/auth/login', {
        body: { identifier: email, password, device: { platform: 'web' } },
      });
      expect(res.status).toBe(200);
      return res.body.accessToken as string;
    }

    /** Create → assign role → activate, exactly as the admin provisioning flow does. */
    async function provision(opts: {
      email: string;
      password: string;
      displayName: string;
      role: string;
    }): Promise<string> {
      const created = await api.call('POST', '/admin/users', {
        token: ownerToken,
        body: {
          displayName: opts.displayName,
          identifier: opts.email,
          initialPassword: opts.password,
        },
      });
      expect(created.status).toBe(201);
      const userId = created.body.id as string;
      const roled = await api.call('POST', `/admin/users/${userId}/roles`, {
        token: ownerToken,
        body: { role: opts.role },
      });
      expect(roled.status).toBe(200);
      expect((roled.body.roles as { code: string }[]).some((r) => r.code === opts.role)).toBe(true);
      const activated = await api.call('POST', `/admin/users/${userId}/status`, {
        token: ownerToken,
        body: { status: 'ACTIVE' },
      });
      expect(activated.status).toBe(200);
      expect(activated.body.status).toBe('ACTIVE');
      return userId;
    }

    beforeAll(async () => {
      scratch = await scratchDatabase(); // fresh DB built by the committed migrations
      api = await startApi({ DATABASE_URL: scratch.url });
      const bootstrapped = await api.app.get(BootstrapOwnerUseCase).execute({
        displayName: 'Owner',
        identifierKind: 'email',
        identifier: OWNER.email,
        password: OWNER.password,
        meta: {},
      });
      if (!bootstrapped.ok) throw new Error(bootstrapped.error.code);
      ownerToken = await login(OWNER.email, OWNER.password);
    }, 90_000);

    afterAll(async () => {
      if (api !== undefined) await api.close();
      if (scratch !== undefined) await scratch.drop();
    });

    it('OWNER creates the academic structure: section → program → halaqa', async () => {
      const section = await api.call('POST', '/academic/sections', {
        token: ownerToken,
        body: { code: 'sec-journey', name: 'قسم الرحلة', order: 1, kind: 'SPECIAL' },
      });
      expect(section.status).toBe(201);
      expectKeys(section.body, ['id', 'code', 'name', 'kind', 'order', 'status']);
      expect(section.body.kind).toBe('SPECIAL');
      id.section = section.body.id as string;

      const program = await api.call('POST', '/academic/programs', {
        token: ownerToken,
        body: { sectionId: id.section, code: 'prog-journey', name: 'برنامج الرحلة', order: 1 },
      });
      expect(program.status).toBe(201);
      expectKeys(program.body, [
        'id',
        'sectionId',
        'code',
        'name',
        'order',
        'status',
        'activeHalaqaCount',
      ]);
      expect(program.body.sectionId).toBe(id.section);
      id.program = program.body.id as string;

      const halaqa = await api.call('POST', '/academic/halaqat', {
        token: ownerToken,
        body: { programId: id.program, code: 'hal-journey', name: 'حلقة الرحلة', order: 1 },
      });
      expect(halaqa.status).toBe(201);
      expectKeys(halaqa.body, ['id', 'programId', 'code', 'name', 'order', 'status']);
      expect(halaqa.body.programId).toBe(id.program);
      id.halaqa = halaqa.body.id as string;
    });

    it('OWNER provisions and activates a TEACHER and a STUDENT (create → role → activate)', async () => {
      id.teacher = await provision({ ...TEACHER, displayName: 'المعلّم', role: 'TEACHER' });
      id.student = await provision({ ...STUDENT, displayName: 'الطالب', role: 'STUDENT' });
    });

    it('OWNER assigns the teacher to the halaqa and enrols the student', async () => {
      const assignment = await api.call('POST', `/academic/halaqat/${id.halaqa}/teachers`, {
        token: ownerToken,
        body: { teacherUserId: id.teacher, role: 'TEACHER' },
      });
      expect(assignment.status).toBe(201);
      // Flutter's AssignmentRecord reads the flat body (no envelope).
      expectKeys(assignment.body, [
        'id',
        'halaqaId',
        'teacherUserId',
        'role',
        'status',
        'startedAt',
      ]);
      expect(assignment.body.teacherUserId).toBe(id.teacher);
      expect(assignment.body.halaqaId).toBe(id.halaqa);
      expect(assignment.body.status).toBe('ACTIVE');

      const enrollment = await api.call('POST', `/academic/halaqat/${id.halaqa}/enrollments`, {
        token: ownerToken,
        body: { studentUserId: id.student },
      });
      expect(enrollment.status).toBe(201);
      // Backend wraps { enrollment, placement }; Flutter reads `enrollment`.
      expect(enrollment.body).toHaveProperty('enrollment');
      expect(enrollment.body).toHaveProperty('placement');
      const record = enrollment.body.enrollment as Record<string, unknown>;
      expectKeys(record, ['id', 'studentUserId', 'halaqaId', 'status', 'enrolledAt']);
      expect(record.studentUserId).toBe(id.student);
      expect(record.halaqaId).toBe(id.halaqa);
      expect(record.status).toBe('ACTIVE');
    });

    it('the TEACHER signs in and sees the halaqa under GET /academic/me `teaching`', async () => {
      teacherToken = await login(TEACHER.email, TEACHER.password);
      const me = await api.call('GET', '/academic/me', { token: teacherToken });
      expect(me.status).toBe(200);
      // MyAcademic.fromJson reads these three keys.
      expectKeys(me.body, ['enrollments', 'teaching', 'truncated']);
      expect(Array.isArray(me.body.teaching)).toBe(true);

      const teaching = me.body.teaching as Record<string, unknown>[];
      const mine = teaching.find(
        (t) => (t.placement as { halaqa?: { id?: string } })?.halaqa?.id === id.halaqa,
      );
      expect(mine).toBeDefined();
      // MyTeaching = { assignment, placement }.
      const assignment = mine!.assignment as Record<string, unknown>;
      const placement = mine!.placement as Record<string, unknown>;
      expectKeys(assignment, ['id', 'halaqaId', 'role', 'status', 'startedAt']);
      expect(assignment.role).toBe('TEACHER');
      expect(assignment.status).toBe('ACTIVE');
      // AcademicPlacement = { section, program, halaqa }; section carries `kind`.
      expectKeys(placement, ['section', 'program', 'halaqa']);
      expect((placement.section as { kind?: string }).kind).toBe('SPECIAL');
      expect((placement.halaqa as { id?: string }).id).toBe(id.halaqa);
    });

    it('the TEACHER reads the halaqa roster and sees the enrolled student', async () => {
      const roster = await api.call('GET', `/academic/halaqat/${id.halaqa}/students`, {
        token: teacherToken,
      });
      expect(roster.status).toBe(200);
      // AcademicPage<HalaqaRosterEntry> = { items: [{ enrollment, student }], nextCursor? }.
      expect(Array.isArray(roster.body.items)).toBe(true);
      const entries = roster.body.items as Record<string, unknown>[];
      const entry = entries.find((e) => (e.student as { userId?: string })?.userId === id.student);
      expect(entry).toBeDefined();
      expect(entry).toHaveProperty('enrollment');
      const student = entry!.student as Record<string, unknown>;
      expectKeys(student, ['userId', 'displayName', 'active']);
      expect(student.active).toBe(true);
    });
  },
);

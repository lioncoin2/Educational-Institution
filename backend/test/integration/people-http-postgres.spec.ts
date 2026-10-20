import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { startApi, type RunningApi } from '../support/api-client';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

const OWNER = { email: 'owner@institution.test', password: 'owner passphrase one' };
const errorOf = (body: Record<string, unknown>) => body.error as { code: string; message: string };
const items = (body: Record<string, unknown>) => body.items as Record<string, unknown>[];

/**
 * The people searches end to end over REAL PostgreSQL: the actual HTTP route →
 * AccessGuard → use case → identity policy → the Drizzle repository (the
 * teacher directory's correlated EXISTS/NOT EXISTS over `role_permissions`) →
 * response serialization. The in-memory `people.api.spec` proves the contract;
 * this proves the SQL and the composition agree with it. Booted with
 * `DATABASE_URL` set, so the application composes its Drizzle adapters (identity
 * picks Postgres when `config.database.configured`).
 */
describeWithPostgres('people API over PostgreSQL (HTTP → Drizzle)', () => {
  let scratch: ScratchDatabase;
  let api: RunningApi;
  let ownerToken: string;
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};

  async function login(email: string, password: string): Promise<string> {
    const res = await api.call('POST', '/auth/login', {
      body: { identifier: email, password, device: { platform: 'web', label: 't' } },
    });
    return res.body.accessToken as string;
  }

  async function provision(opts: {
    key: string;
    email: string;
    password: string;
    displayName: string;
    role: string;
    activate: boolean;
  }): Promise<void> {
    const created = await api.call('POST', '/admin/users', {
      token: ownerToken,
      body: {
        displayName: opts.displayName,
        identifier: opts.email,
        initialPassword: opts.password,
      },
    });
    const id = created.body.id as string;
    ids[opts.key] = id;
    await api.call('POST', `/admin/users/${id}/roles`, {
      token: ownerToken,
      body: { role: opts.role },
    });
    if (opts.activate) {
      await api.call('POST', `/admin/users/${id}/status`, {
        token: ownerToken,
        body: { status: 'ACTIVE' },
      });
      tokens[opts.key] = await login(opts.email, opts.password);
    }
  }

  beforeAll(async () => {
    scratch = await scratchDatabase(); // fresh DB, the committed migrations (incl. 0019 seeds)
    api = await startApi({ DATABASE_URL: scratch.url });
    const bootstrapped = await api.app.get(BootstrapOwnerUseCase).execute({
      displayName: 'Owner',
      identifierKind: 'email',
      identifier: OWNER.email,
      password: OWNER.password,
      meta: {},
    });
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.code);
    ids.owner = bootstrapped.value.id;
    ownerToken = await login(OWNER.email, OWNER.password);

    await provision({
      key: 'teacher',
      email: 'sami@institution.test',
      password: 'teacher passphrase',
      displayName: 'سامي المعلّم',
      role: 'TEACHER',
      activate: true,
    });
    await provision({
      key: 'assistant',
      email: 'samer@institution.test',
      password: 'assistant passphrase',
      displayName: 'سامر المساعد',
      role: 'ASSISTANT_TEACHER',
      activate: true,
    });
    await provision({
      key: 'student',
      email: 'sara@institution.test',
      password: 'student passphrase',
      displayName: 'سارة الطالبة',
      role: 'STUDENT',
      activate: true,
    });
    await provision({
      key: 'admin',
      email: 'samia@institution.test',
      password: 'admin passphrase here',
      displayName: 'سامية المديرة',
      role: 'ADMIN',
      activate: true,
    });
    // A teacher whose name matches but who is never ACTIVE — must not surface.
    await provision({
      key: 'inactive',
      email: 'salim@institution.test',
      password: 'inactive passphrase',
      displayName: 'سالم المعلّم',
      role: 'TEACHER',
      activate: false,
    });
  }, 90_000);

  afterAll(async () => {
    await api.close();
    await scratch.drop();
  });

  describe('GET /people/teachers (the teacher directory, over real SQL)', () => {
    it('returns only ACTIVE eligible teachers — teacher and assistant, never student, admin, owner, inactive', async () => {
      const res = await api.call('GET', '/people/teachers?q=سا', { token: tokens.student });
      expect(res.status).toBe(200);
      const found = items(res.body).map((i) => i.userId);
      expect(found).toContain(ids.teacher);
      expect(found).toContain(ids.assistant);
      expect(found).not.toContain(ids.student);
      expect(found).not.toContain(ids.admin);
      expect(found).not.toContain(ids.owner);
      expect(found).not.toContain(ids.inactive);
    });

    it('discloses only {userId, displayName, avatarFileAssetId} — no email, role or status', async () => {
      const res = await api.call('GET', '/people/teachers?q=سا', { token: tokens.student });
      for (const item of items(res.body)) {
        // The avatar is an opaque Files asset id (ADR 0038): it travels with the
        // name wherever the name is shown, and is resolved to a link only through
        // the authorized avatar route — never an email, role or status.
        expect(Object.keys(item).sort()).toEqual(['avatarFileAssetId', 'displayName', 'userId']);
      }
      expect(res.raw).not.toContain('@institution.test');
      expect(res.raw).not.toContain('email');
    });

    it('refuses an unauthenticated caller (401) and a teacher without the capability (403)', async () => {
      const anon = await api.call('GET', '/people/teachers?q=سا');
      expect(anon.status).toBe(401);
      expect(errorOf(anon.body).code).toBe('identity.authentication_required');

      const staff = await api.call('GET', '/people/teachers?q=سا', { token: tokens.teacher });
      expect(staff.status).toBe(403);
      expect(errorOf(staff.body).code).toBe('identity.permission_denied');
    });

    it('validates the query and paginates by an opaque cursor over SQL', async () => {
      expect((await api.call('GET', '/people/teachers', { token: tokens.student })).status).toBe(
        400,
      );
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const path =
          cursor === null
            ? '/people/teachers?q=سا&limit=1'
            : `/people/teachers?q=سا&limit=1&cursor=${encodeURIComponent(cursor)}`;
        const res = await api.call('GET', path, { token: tokens.student });
        for (const i of items(res.body)) seen.push(i.userId as string);
        cursor = (res.body.nextCursor as string | null) ?? null;
        if (cursor === null) break;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expect.arrayContaining([ids.teacher, ids.assistant]));
      expect(seen).not.toContain(ids.student);
    });
  });

  describe('GET /people is an owner/admin directory over SQL (Sprint 24, Design X)', () => {
    it('refuses a student and a teacher (403), serves an admin (200)', async () => {
      const student = await api.call('GET', '/people?q=سا', { token: tokens.student });
      expect(student.status).toBe(403);
      expect(errorOf(student.body).code).toBe('identity.permission_denied');

      // A teacher no longer holds people.read — the global directory is closed.
      const teacher = await api.call('GET', '/people?q=سا', { token: tokens.teacher });
      expect(teacher.status).toBe(403);
      expect(errorOf(teacher.body).code).toBe('identity.permission_denied');

      // An admin retains the institution-wide directory, and it is not role-scoped.
      const staff = await api.call('GET', '/people?q=سا', { token: tokens.admin });
      expect(staff.status).toBe(200);
      expect(items(staff.body).map((i) => i.userId)).toContain(ids.student);
    });
  });
});

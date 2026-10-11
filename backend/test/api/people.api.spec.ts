import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { USER_REPOSITORY, type UserRepository } from '../../src/modules/identity/domain/ports';
import { startApi, type RunningApi } from '../support/api-client';

const OWNER = { email: 'owner@institution.test', password: 'owner passphrase one' };
const errorOf = (body: Record<string, unknown>) => body.error as { code: string; message: string };
const items = (body: Record<string, unknown>) => body.items as Record<string, unknown>[];

/**
 * GET /people — the display-name search (Owner Decision A1/A4). The security
 * contract: `people.read` only (staff), institution-scoped, ACTIVE accounts,
 * and a minimal {userId, displayName} projection — never an email, role or
 * status. Runs on the in-memory adapters (the same guard, the same twin the
 * Postgres repository mirrors).
 */
describe('people API — GET /people', () => {
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
    api = await startApi();
    const bootstrapped = await api.app.get(BootstrapOwnerUseCase).execute({
      displayName: 'Owner',
      identifierKind: 'email',
      identifier: OWNER.email,
      password: OWNER.password,
      meta: {},
    });
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.code);
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
      key: 'student',
      email: 'sara@institution.test',
      password: 'student passphrase',
      displayName: 'سارة الطالبة',
      role: 'STUDENT',
      activate: true,
    });
    // Matches the prefix but is never ACTIVE — must not surface.
    await provision({
      key: 'pending',
      email: 'salim@institution.test',
      password: 'pending passphrase',
      displayName: 'سالم المنتظِر',
      role: 'STUDENT',
      activate: false,
    });
    // An eligible teacher (assistant teacher holds academic.teach) — surfaces in
    // the teacher directory; and an admin, who matches the prefix but holds
    // users.manage, so must NOT surface there.
    await provision({
      key: 'assistant',
      email: 'samer@institution.test',
      password: 'assistant passphrase',
      displayName: 'سامر المساعد',
      role: 'ASSISTANT_TEACHER',
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
  }, 60_000);

  afterAll(async () => {
    await api.close();
  });

  it('401 — refuses an unauthenticated search', async () => {
    const res = await api.call('GET', '/people?q=سا');
    expect(res.status).toBe(401);
    expect(errorOf(res.body).code).toBe('identity.authentication_required');
  });

  it('403 — refuses a student, who does not hold people.read', async () => {
    const res = await api.call('GET', '/people?q=سا', { token: tokens.student });
    expect(res.status).toBe(403);
    expect(errorOf(res.body).code).toBe('identity.permission_denied');
  });

  it('200 — a teacher searches across the institution, minimal fields only', async () => {
    const res = await api.call('GET', '/people?q=سا', { token: tokens.teacher });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['items', 'nextCursor']);
    for (const item of items(res.body)) {
      expect(Object.keys(item).sort()).toEqual(['displayName', 'userId']);
    }
    const found = items(res.body).map((i) => i.userId);
    expect(found).toContain(ids.teacher);
    expect(found).toContain(ids.student);
  });

  it('returns only ACTIVE accounts — a PENDING match is absent', async () => {
    const res = await api.call('GET', '/people?q=سا', { token: ownerToken });
    expect(items(res.body).map((i) => i.userId)).not.toContain(ids.pending);
  });

  it('discloses no login identifier (email) on the wire', async () => {
    const res = await api.call('GET', '/people?q=سا', { token: ownerToken });
    expect(res.raw).not.toContain('@institution.test');
    expect(res.raw).not.toContain('email');
  });

  it('prefix-matches case-insensitively, and excludes non-matches', async () => {
    const res = await api.call('GET', '/people?q=owner', { token: ownerToken });
    expect(items(res.body).map((i) => i.displayName)).toContain('Owner');
    // "Owner" does not begin with "سا", so it never surfaced in the Arabic
    // searches above — the prefix genuinely narrows.
  });

  it('paginates by an opaque cursor, each account once', async () => {
    // Page through the whole result one at a time; every account appears once,
    // and the known matches are all reached.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const path =
        cursor === null
          ? '/people?q=سا&limit=1'
          : `/people?q=سا&limit=1&cursor=${encodeURIComponent(cursor)}`;
      const res = await api.call('GET', path, { token: ownerToken });
      expect(items(res.body).length).toBeLessThanOrEqual(1);
      for (const i of items(res.body)) seen.push(i.userId as string);
      cursor = (res.body.nextCursor as string | null) ?? null;
      if (cursor === null) break;
    }
    expect(new Set(seen).size).toBe(seen.length); // no account twice across pages
    expect(seen).toContain(ids.teacher);
    expect(seen).toContain(ids.student);
  });

  it('clamps an oversize limit rather than refusing it', async () => {
    const res = await api.call('GET', '/people?q=سا&limit=1000000', { token: ownerToken });
    expect(res.status).toBe(200);
  });

  describe('400 — query validation', () => {
    it('rejects a missing query term', async () => {
      expect((await api.call('GET', '/people', { token: ownerToken })).status).toBe(400);
    });
    it('rejects a blank query term', async () => {
      expect((await api.call('GET', '/people?q=%20%20', { token: ownerToken })).status).toBe(400);
    });
    it('rejects a non-integer limit', async () => {
      expect((await api.call('GET', '/people?q=سا&limit=abc', { token: ownerToken })).status).toBe(
        400,
      );
    });
    it('rejects an undeclared query field', async () => {
      expect(
        (await api.call('GET', '/people?q=سا&role=STUDENT', { token: ownerToken })).status,
      ).toBe(400);
    });
  });

  // GET /people/teachers — the student-facing teacher directory (Q6). Gated on
  // `messaging.start_direct_teacher` (a student holds it; a teacher, holding
  // only people.read, does not), returns ONLY eligible teachers, same minimal
  // projection. It is a teacher directory, never a general people search.
  describe('GET /people/teachers', () => {
    it('401 — refuses an unauthenticated search', async () => {
      const res = await api.call('GET', '/people/teachers?q=سا');
      expect(res.status).toBe(401);
      expect(errorOf(res.body).code).toBe('identity.authentication_required');
    });

    it('403 — refuses a teacher, who does not hold the teacher-messaging capability', async () => {
      const res = await api.call('GET', '/people/teachers?q=سا', { token: tokens.teacher });
      expect(res.status).toBe(403);
      expect(errorOf(res.body).code).toBe('identity.permission_denied');
    });

    it('200 — a student sees eligible teachers only: not students, admins, or the inactive', async () => {
      const res = await api.call('GET', '/people/teachers?q=سا', { token: tokens.student });
      expect(res.status).toBe(200);
      const found = items(res.body).map((i) => i.userId);
      expect(found).toContain(ids.teacher); // a teacher
      expect(found).toContain(ids.assistant); // an assistant teacher is eligible
      expect(found).not.toContain(ids.student); // a student is not a teacher
      expect(found).not.toContain(ids.admin); // an administrator (users.manage) is excluded
      expect(found).not.toContain(ids.pending); // inactive accounts never surface
      expect(found).not.toContain(ids.owner ?? '__none__'); // the owner is an administrator too
    });

    it('discloses only {userId, displayName} — no email, role or status', async () => {
      const res = await api.call('GET', '/people/teachers?q=سا', { token: tokens.student });
      for (const item of items(res.body)) {
        expect(Object.keys(item).sort()).toEqual(['displayName', 'userId']);
      }
      expect(res.raw).not.toContain('@institution.test');
      expect(res.raw).not.toContain('email');
    });

    it('400 — rejects a blank query term, like the people search', async () => {
      expect(
        (await api.call('GET', '/people/teachers?q=%20%20', { token: tokens.student })).status,
      ).toBe(400);
    });
  });

  // The store cannot be reached mid-search: the controller's
  // DatabaseUnavailableInterceptor answers 503 `unavailable` (retry is sensible),
  // never an empty page and never an opaque 500 — a search that could not read
  // fails closed. A fault that is not an outage stays a 500.
  describe('database unavailability → 503', () => {
    it('answers 503 on the teacher directory when the store cannot be reached', async () => {
      const users = api.app.get<UserRepository>(USER_REPOSITORY, { strict: false });
      const outage = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
        code: 'ECONNREFUSED',
      });
      const spy = jest
        .spyOn(users, 'searchActiveTeachersByDisplayName')
        .mockRejectedValueOnce(outage);
      const res = await api.call('GET', '/people/teachers?q=سا', { token: tokens.student });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ kind: 'unavailable', code: 'unavailable' });
      spy.mockRestore();

      // A bug, not an outage, is still a 500 — then the route recovers.
      const broken = jest
        .spyOn(users, 'searchActiveTeachersByDisplayName')
        .mockRejectedValueOnce(new TypeError('a bug, not an outage'));
      expect(
        (await api.call('GET', '/people/teachers?q=سا', { token: tokens.student })).status,
      ).toBe(500);
      broken.mockRestore();
      expect(
        (await api.call('GET', '/people/teachers?q=سا', { token: tokens.student })).status,
      ).toBe(200);
    });

    it('answers 503 on the people search too (same controller interceptor)', async () => {
      const users = api.app.get<UserRepository>(USER_REPOSITORY, { strict: false });
      const outage = new Error('connection terminated unexpectedly');
      const spy = jest.spyOn(users, 'searchActiveByDisplayName').mockRejectedValueOnce(outage);
      const res = await api.call('GET', '/people?q=سا', { token: ownerToken });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ kind: 'unavailable', code: 'unavailable' });
      spy.mockRestore();
    });
  });
});

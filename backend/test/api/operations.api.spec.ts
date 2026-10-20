import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { startApi, type RunningApi } from '../support/api-client';

const OWNER = { email: 'owner@institution.test', password: 'owner passphrase one' };

const errorOf = (body: Record<string, unknown>) => body.error as { code: string; message: string };

/**
 * POST/GET/PATCH /operations/lessons — scheduling of individual dated lessons
 * (ADR 0042). The contract: every route requires `operations.schedule_manage`
 * (owner/admin); a lesson captures its wall-clock + IANA zone and a resolved
 * instant; nonexistent DST times and past times are refused; cancellation is a
 * state transition; retries are idempotent by `clientRequestId`. Runs on the
 * in-memory adapters (the same guard the Postgres repo mirrors). No institution
 * default timezone is configured in the test env, so creates name a zone.
 */
describe('operations API — scheduled lessons', () => {
  let api: RunningApi;
  let ownerToken: string;
  let teacherToken: string;
  let halaqaId: string;

  async function login(email: string, password: string): Promise<string> {
    const res = await api.call('POST', '/auth/login', {
      body: { identifier: email, password, device: { platform: 'web', label: 't' } },
    });
    return res.body.accessToken as string;
  }

  async function provision(
    displayName: string,
    identifier: string,
    password: string,
    role: string,
  ): Promise<void> {
    const created = await api.call('POST', '/admin/users', {
      token: ownerToken,
      body: { displayName, identifier, initialPassword: password },
    });
    const id = created.body.id as string;
    await api.call('POST', `/admin/users/${id}/roles`, { token: ownerToken, body: { role } });
    await api.call('POST', `/admin/users/${id}/status`, {
      token: ownerToken,
      body: { status: 'ACTIVE' },
    });
  }

  async function resolveHalaqaId(): Promise<string> {
    const catalogue = await api.call('GET', '/academic/sections', { token: ownerToken });
    const sections = (catalogue.body.sections ?? []) as {
      programs: { id: string; activeHalaqaCount: number }[];
    }[];
    for (const section of sections) {
      for (const program of section.programs) {
        const detail = await api.call('GET', `/academic/programs/${program.id}`, {
          token: ownerToken,
        });
        const halaqat = (detail.body.halaqat ?? []) as { id: string }[];
        if (halaqat.length > 0) return halaqat[0].id;
      }
    }
    throw new Error('no seeded halaqa to schedule against');
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

    await provision('سامي المعلّم', 'sami@institution.test', 'teacher passphrase', 'TEACHER');
    teacherToken = await login('sami@institution.test', 'teacher passphrase');

    halaqaId = await resolveHalaqaId();
  });

  afterAll(async () => {
    await api.close();
  });

  const future = { date: '2027-03-01', time: '09:00', timezone: 'Asia/Riyadh' };

  it('401 without a token', async () => {
    const res = await api.call('POST', '/operations/lessons', { body: { halaqaId, ...future } });
    expect(res.status).toBe(401);
  });

  it('403 for a caller without operations.schedule_manage (a teacher)', async () => {
    const res = await api.call('POST', '/operations/lessons', {
      token: teacherToken,
      body: { halaqaId, ...future },
    });
    expect(res.status).toBe(403);
    expect(errorOf(res.body).code).toBe('identity.permission_denied');
  });

  it('schedules a lesson for the owner and round-trips the wall clock + instant', async () => {
    const res = await api.call('POST', '/operations/lessons', {
      token: ownerToken,
      body: { halaqaId, title: 'الدرس الأول', ...future },
    });
    expect(res.status).toBe(201);
    expect(res.body.localDate).toBe('2027-03-01');
    expect(res.body.localTime).toBe('09:00');
    expect(res.body.timezone).toBe('Asia/Riyadh');
    expect(res.body.scheduledAt).toBe('2027-03-01T06:00:00.000Z'); // +03:00
    expect(res.body.status).toBe('SCHEDULED');
    expect(res.body.title).toBe('الدرس الأول');

    // Retrievable and listed.
    const got = await api.call('GET', `/operations/lessons/${res.body.id as string}`, {
      token: ownerToken,
    });
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(res.body.id);

    const list = await api.call('GET', `/operations/lessons?halaqaId=${halaqaId}`, {
      token: ownerToken,
    });
    expect(list.status).toBe(200);
    expect((list.body.items as { id: string }[]).some((l) => l.id === res.body.id)).toBe(true);
  });

  it('requires a timezone when none is given and the institution has no default', async () => {
    const res = await api.call('POST', '/operations/lessons', {
      token: ownerToken,
      body: { halaqaId, date: '2027-03-01', time: '09:00' },
    });
    expect(res.status).toBe(422);
    expect(errorOf(res.body).code).toBe('operations.timezone_required');
  });

  it('404s an unknown halaqa', async () => {
    const res = await api.call('POST', '/operations/lessons', {
      token: ownerToken,
      body: { halaqaId: 'no-such-halaqa', ...future },
    });
    expect(res.status).toBe(404);
    expect(errorOf(res.body).code).toBe('operations.halaqa_not_found');
  });

  it('422s a DST-nonexistent local time', async () => {
    // America/New_York 2027-03-14 02:30 is skipped by the spring-forward gap.
    const res = await api.call('POST', '/operations/lessons', {
      token: ownerToken,
      body: { halaqaId, date: '2027-03-14', time: '02:30', timezone: 'America/New_York' },
    });
    expect(res.status).toBe(422);
    expect(errorOf(res.body).code).toBe('operations.local_time_nonexistent');
  });

  it('422s a lesson in the past', async () => {
    const res = await api.call('POST', '/operations/lessons', {
      token: ownerToken,
      body: { halaqaId, date: '2020-01-01', time: '09:00', timezone: 'Asia/Riyadh' },
    });
    expect(res.status).toBe(422);
    expect(errorOf(res.body).code).toBe('operations.lesson_in_the_past');
  });

  it('400s a malformed request body (missing date)', async () => {
    const res = await api.call('POST', '/operations/lessons', {
      token: ownerToken,
      body: { halaqaId, time: '09:00', timezone: 'Asia/Riyadh' },
    });
    expect(res.status).toBe(400);
  });

  it('reschedules, then cancels, then refuses to cancel again', async () => {
    const created = await api.call('POST', '/operations/lessons', {
      token: ownerToken,
      body: { halaqaId, ...future },
    });
    const id = created.body.id as string;

    const rescheduled = await api.call('PATCH', `/operations/lessons/${id}`, {
      token: ownerToken,
      body: { date: '2027-04-01', time: '08:00' },
    });
    expect(rescheduled.status).toBe(200);
    expect(rescheduled.body.localDate).toBe('2027-04-01');
    expect(rescheduled.body.scheduledAt).toBe('2027-04-01T05:00:00.000Z');

    const cancelled = await api.call('POST', `/operations/lessons/${id}/cancel`, {
      token: ownerToken,
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.cancelledAt).not.toBeNull();

    const again = await api.call('POST', `/operations/lessons/${id}/cancel`, { token: ownerToken });
    expect(again.status).toBe(412);
    expect(errorOf(again.body).code).toBe('operations.lesson_not_modifiable');
  });

  it('is idempotent for a repeated clientRequestId', async () => {
    const body = { halaqaId, ...future, clientRequestId: 'batch-xyz' };
    const first = await api.call('POST', '/operations/lessons', { token: ownerToken, body });
    expect(first.status).toBe(201);
    const second = await api.call('POST', '/operations/lessons', { token: ownerToken, body });
    expect(second.status).toBe(200); // replay, not a new 201
    expect(second.body.id).toBe(first.body.id);
  });

  it('refuses a teacher reading a lesson by id (no enumeration via guessed ids)', async () => {
    const created = await api.call('POST', '/operations/lessons', {
      token: ownerToken,
      body: { halaqaId, ...future },
    });
    const res = await api.call('GET', `/operations/lessons/${created.body.id as string}`, {
      token: teacherToken,
    });
    expect(res.status).toBe(403);
  });
});

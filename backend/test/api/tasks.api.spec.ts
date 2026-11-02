import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { startApi, type RunningApi } from '../support/api-client';

const OWNER = { email: 'owner@institution.test', password: 'owner passphrase one' };

const errorOf = (body: Record<string, unknown>) => body.error as { code: string };

/**
 * The daily tasks engine over HTTP (ADR 0052), through the real app on the
 * in-memory adapters: the route guards and the use-case authorization, the
 * edge validation, a whole publish → acknowledge → report → approve → archive
 * cycle, and the export formats with their safety headers.
 */
describe('tasks API — the daily tasks & reports engine', () => {
  let api: RunningApi;
  const tokens: Record<string, string> = {};

  async function login(email: string, password: string): Promise<string> {
    const res = await api.call('POST', '/auth/login', {
      body: { identifier: email, password, device: { platform: 'web', label: 't' } },
    });
    return res.body.accessToken as string;
  }

  async function provision(name: string, role: string): Promise<void> {
    const email = `${name}@institution.test`;
    const created = await api.call('POST', '/admin/users', {
      token: tokens.owner,
      body: { displayName: name, identifier: email, initialPassword: `${name} passphrase` },
    });
    const id = created.body.id as string;
    await api.call('POST', `/admin/users/${id}/roles`, { token: tokens.owner, body: { role } });
    await api.call('POST', `/admin/users/${id}/status`, {
      token: tokens.owner,
      body: { status: 'ACTIVE' },
    });
    tokens[name] = await login(email, `${name} passphrase`);
  }

  const publishBody = (over: Record<string, unknown> = {}) => ({
    title: 'تحضير درس الغد',
    body: 'اكتبي خطة الدرس',
    kind: 'GENERAL',
    buttons: ['ACKNOWLEDGE', 'COMPLETE'],
    reportRequired: true,
    approvalMode: 'MANUAL',
    audiences: ['TEACHERS'],
    ...over,
  });

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
    tokens.owner = await login(OWNER.email, OWNER.password);
    await provision('teacher', 'TEACHER');
    await provision('admin', 'ADMIN');
    await provision('student', 'STUDENT');
  });

  afterAll(async () => {
    await api.close();
  });

  it('401 without a token, 403 for a role without the permission', async () => {
    expect((await api.call('GET', '/tasks')).status).toBe(401);
    const teacher = await api.call('POST', '/tasks', {
      token: tokens.teacher,
      body: publishBody(),
    });
    expect(teacher.status).toBe(403);
    expect(errorOf(teacher.body).code).toBe('identity.permission_denied');
    expect((await api.call('GET', '/my-tasks', { token: tokens.student })).status).toBe(403);
    const template = await api.call('POST', '/task-templates', {
      token: tokens.admin,
      body: { draft: publishBody() },
    });
    expect(template.status).toBe(403);
  });

  it('400 at the edge for an unknown audience or button', async () => {
    const res = await api.call('POST', '/tasks', {
      token: tokens.owner,
      body: publishBody({ audiences: ['EVERYONE'], buttons: ['APPLAUD'] }),
    });
    expect(res.status).toBe(400);
  });

  it('runs a task from publish to the archive, and 404s someone else’s assignment', async () => {
    const created = await api.call('POST', '/tasks', {
      token: tokens.owner,
      body: publishBody({ clientRequestId: 'api-key-0001' }),
    });
    expect(created.status).toBe(201);
    const taskId = created.body.id as string;
    const retry = await api.call('POST', '/tasks', {
      token: tokens.owner,
      body: publishBody({ clientRequestId: 'api-key-0001' }),
    });
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(taskId);

    const mine = await api.call('GET', '/my-tasks', { token: tokens.teacher });
    const items = mine.body.items as { assignment: { id: string }; task: { id: string } }[];
    const assignmentId = items.find((i) => i.task.id === taskId)!.assignment.id;
    const byTask = await api.call('GET', `/my-tasks/by-task/${taskId}`, { token: tokens.teacher });
    expect((byTask.body.assignment as { id: string }).id).toBe(assignmentId);
    expect(
      (await api.call('GET', `/my-tasks/${assignmentId}`, { token: tokens.admin })).status,
    ).toBe(404);

    expect(
      (await api.call('POST', `/my-tasks/${assignmentId}/acknowledge`, { token: tokens.teacher }))
        .status,
    ).toBe(200);
    const done = await api.call('POST', `/my-tasks/${assignmentId}/complete`, {
      token: tokens.teacher,
      body: { report: 'الخطة جاهزة' },
    });
    expect(done.body.status).toBe('COMPLETED');

    const reports = await api.call('GET', '/task-reports', { token: tokens.admin });
    const report = (reports.body.items as { id: string; status: string; taskId: string }[]).find(
      (r) => r.taskId === taskId,
    )!;
    expect(report.status).toBe('PENDING_REVIEW');
    const approved = await api.call('POST', `/task-reports/${report.id}/review`, {
      token: tokens.admin,
      body: { version: 1, decision: 'APPROVED' },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    // The act answers with ids; the report's page names who approved it.
    const detail = await api.call('GET', `/task-reports/${report.id}`, { token: tokens.owner });
    expect((detail.body.report as { approvedBy: { name: string } }).approvedBy.name).toBe('admin');

    const task = await api.call('GET', `/tasks/${taskId}`, { token: tokens.owner });
    expect((task.body.task as { state: string }).state).toBe('ARCHIVED');
    const history = await api.call('GET', `/tasks/${taskId}/history`, { token: tokens.admin });
    const actions = (history.body.items as { action: string }[]).map((e) => e.action);
    expect(actions[0]).toBe('TASK_PUBLISHED');
    expect(actions[actions.length - 1]).toBe('TASK_ARCHIVED');
  });

  it('serves the dashboard and exports CSV for Excel and print-ready HTML', async () => {
    const board = await api.call('GET', '/task-dashboard', { token: tokens.admin });
    expect(board.status).toBe(200);
    expect((board.body.totals as { tasks: number }).tasks).toBeGreaterThanOrEqual(1);

    const csv = await fetch(`${api.base}/task-dashboard/export?format=csv`, {
      headers: { authorization: `Bearer ${tokens.admin}` },
    });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = Buffer.from(await csv.arrayBuffer());
    // UTF-8 byte-order mark, so Excel reads the Arabic as Arabic.
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8');
    expect(text).toContain('"المهمة"');

    const html = await fetch(`${api.base}/task-dashboard/export?format=html`, {
      headers: { authorization: `Bearer ${tokens.admin}` },
    });
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");
    const page = await html.text();
    expect(page).toContain('dir="rtl"');
    expect(page).not.toContain('<script');

    const student = await fetch(`${api.base}/task-dashboard/export`, {
      headers: { authorization: `Bearer ${tokens.student}` },
    });
    expect(student.status).toBe(403);
  });
});

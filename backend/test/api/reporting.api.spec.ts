import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { startApi, type RunningApi } from '../support/api-client';

const OWNER = { email: 'owner@institution.test', password: 'owner passphrase one' };

type Widget = { id: string; category: string; title: string; payload: Record<string, unknown> };
type Action = { id: string; title: string };
const widgetsOf = (body: Record<string, unknown>) => body.widgets as Widget[];
const actionsOf = (body: Record<string, unknown>) => body.actions as Action[];
const errorOf = (body: Record<string, unknown>) => body.error as { code: string; message: string };

/**
 * GET /reporting/command-center — the Owner Command Center. The contract:
 * `reports.read` at the edge, each widget hidden unless the viewer holds its
 * permission, and FACTS only (counts of existing authorized data — the academic
 * structure the in-memory store seeds at boot, and the communities that exist).
 * Runs on the in-memory adapters (the same guard the Postgres repos mirror).
 */
describe('reporting API — GET /reporting/command-center', () => {
  let api: RunningApi;
  let ownerToken: string;
  let teacherToken: string;
  let supervisorToken: string;

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

  async function login(email: string, password: string): Promise<string> {
    const res = await api.call('POST', '/auth/login', {
      body: { identifier: email, password, device: { platform: 'web', label: 't' } },
    });
    return res.body.accessToken as string;
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

    // A teacher holds no reports.read — the endpoint-level refusal case.
    await provision('سامي المعلّم', 'sami@institution.test', 'teacher passphrase', 'TEACHER');
    teacherToken = await login('sami@institution.test', 'teacher passphrase');

    // A supervisor holds reports.read but NOT users.manage (admin-only) — so the
    // accounts widget and accounts.admin action must be hidden from them.
    await provision('هدى المشرفة', 'huda@institution.test', 'supervisor passphrase', 'SUPERVISOR');
    supervisorToken = await login('huda@institution.test', 'supervisor passphrase');
  });

  afterAll(async () => {
    await api.close();
  });

  it('401 without a token', async () => {
    const res = await api.call('GET', '/reporting/command-center');
    expect(res.status).toBe(401);
  });

  it('403 for a caller without reports.read (a teacher)', async () => {
    const res = await api.call('GET', '/reporting/command-center', { token: teacherToken });
    expect(res.status).toBe(403);
    expect(errorOf(res.body).code).toBe('identity.permission_denied');
  });

  it('returns the owner the command-center widgets, each with facts', async () => {
    const res = await api.call('GET', '/reporting/command-center', { token: ownerToken });
    expect(res.status).toBe(200);
    const widgets = widgetsOf(res.body);
    const byId = new Map(widgets.map((w) => [w.id, w]));

    // Both registered widgets are visible to the owner (holds every permission).
    expect(byId.has('communities.summary')).toBe(true);
    expect(byId.has('academic.structure')).toBe(true);

    // Every widget carries a presentation and a metrics payload — no leaked
    // requiredPermission on the wire.
    for (const widget of widgets) {
      expect(typeof widget.title).toBe('string');
      expect(typeof widget.category).toBe('string');
      expect(widget).not.toHaveProperty('requiredPermission');
      expect(Array.isArray((widget.payload as { metrics?: unknown }).metrics)).toBe(true);
    }

    // FACTS, not invented: the in-memory academic structure is seeded at boot,
    // so the active-halaqat figure is a real, positive count.
    const academic = byId.get('academic.structure')!;
    const metrics = (academic.payload as { metrics: { key: string; value: number }[] }).metrics;
    const halaqat = metrics.find((m) => m.key === 'halaqat_active');
    expect(halaqat).toBeDefined();
    expect(halaqat!.value).toBeGreaterThan(0);

    // No community has been created in this run → a truthful zero, not a guess.
    const communities = byId.get('communities.summary')!;
    const cMetrics = (communities.payload as { metrics: { key: string; value: number }[] }).metrics;
    expect(cMetrics.find((m) => m.key === 'total')!.value).toBe(0);

    // The accounts widget (users.manage) is visible to the owner, with a real,
    // positive total — at least the owner, the teacher and the supervisor exist.
    const accounts = byId.get('accounts.summary');
    expect(accounts).toBeDefined();
    const aMetrics = (accounts!.payload as { metrics: { key: string; value: number }[] }).metrics;
    expect(aMetrics.find((m) => m.key === 'total')!.value).toBeGreaterThanOrEqual(3);
    expect(aMetrics.find((m) => m.key === 'active')!.value).toBeGreaterThanOrEqual(3);
  });

  it('returns the owner the quick actions they may perform, with no requiredPermission leaked', async () => {
    const res = await api.call('GET', '/reporting/command-center', { token: ownerToken });
    const actions = actionsOf(res.body);
    const ids = actions.map((a) => a.id);
    // The owner holds every permission, so sees every catalogued action.
    expect(ids).toEqual(
      expect.arrayContaining([
        'publish.communities',
        'communities.create',
        'academic.structure',
        'accounts.admin',
      ]),
    );
    for (const action of actions) {
      expect(typeof action.title).toBe('string');
      expect(action).not.toHaveProperty('requiredPermission');
    }
  });

  it('hides from a supervisor the widgets and actions they lack the permission for', async () => {
    const res = await api.call('GET', '/reporting/command-center', { token: supervisorToken });
    expect(res.status).toBe(200); // a supervisor holds reports.read
    const widgetIds = widgetsOf(res.body).map((w) => w.id);
    const actionIds = actionsOf(res.body).map((a) => a.id);
    // No users.manage → neither the accounts widget nor the accounts action.
    expect(widgetIds).not.toContain('accounts.summary');
    expect(actionIds).not.toContain('accounts.admin');
    // No communities.create → that action is hidden too.
    expect(actionIds).not.toContain('communities.create');
  });
});

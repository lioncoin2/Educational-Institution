import { err, failure, ok, type Principal } from '../../../shared';
import type { AuthorizationService } from '../../identity/contracts/authorization';
import type { CommandActionDescriptor, WidgetData, WidgetProvider } from '../contracts';
import { GetCommandCenterUseCase } from './get-command-center.use-case';

const viewer: Principal = {
  userId: 'u-1',
  roles: ['OWNER'],
  permissions: new Set(),
};

/** Authorizes only the permissions in `held`; everything else is refused. */
function auth(held: Set<string>): AuthorizationService {
  return {
    can: (_p, permission) => held.has(permission),
    authorize: (_p, permission) =>
      held.has(permission)
        ? ok(undefined)
        : err(failure('forbidden', 'identity.permission_denied', 'Not allowed.')),
  };
}

/** A widget that records whether it was resolved, so hiding can be proven. */
function recordingWidget(id: string, requiredPermission: string) {
  const calls: string[] = [];
  const provider: WidgetProvider = {
    descriptor: { id, category: 'today', title: id, requiredPermission },
    resolve: async (viewerUserId: string): Promise<WidgetData> => {
      calls.push(viewerUserId);
      return { widgetId: id, payload: { metrics: [{ key: 'v', label: id, value: 1 }] } };
    },
  };
  return { provider, calls };
}

describe('GetCommandCenterUseCase', () => {
  it('refuses a caller without reports.read, and resolves no widget', async () => {
    const a = recordingWidget('communities.summary', 'communities.read');
    const useCase = new GetCommandCenterUseCase(auth(new Set()), [a.provider], []);

    const result = await useCase.execute({ principal: viewer });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('forbidden');
    expect(a.calls).toHaveLength(0); // the right is checked before any resolve
  });

  it('returns only the widgets whose permission the viewer holds (hides the rest)', async () => {
    const a = recordingWidget('communities.summary', 'communities.read');
    const b = recordingWidget('academic.structure', 'academic.read');
    // Holds reports.read + communities.read, but NOT academic.read.
    const useCase = new GetCommandCenterUseCase(
      auth(new Set(['reports.read', 'communities.read'])),
      [a.provider, b.provider],
      [],
    );

    const result = await useCase.execute({ principal: viewer });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.widgets.map((w) => w.descriptor.id)).toEqual(['communities.summary']);
    }
    expect(a.calls).toEqual(['u-1']); // resolved for the viewer
    expect(b.calls).toHaveLength(0); // hidden → never resolved (no data leak)
  });

  it('resolves every visible widget and passes the viewer id through', async () => {
    const a = recordingWidget('communities.summary', 'communities.read');
    const b = recordingWidget('academic.structure', 'academic.read');
    const useCase = new GetCommandCenterUseCase(
      auth(new Set(['reports.read', 'communities.read', 'academic.read'])),
      [a.provider, b.provider],
      [],
    );

    const result = await useCase.execute({ principal: viewer });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.widgets.map((w) => w.descriptor.id)).toEqual([
        'communities.summary',
        'academic.structure',
      ]);
      expect(result.value.widgets[0].data.payload).toHaveProperty('metrics');
    }
    expect(a.calls).toEqual(['u-1']);
    expect(b.calls).toEqual(['u-1']);
  });

  it('answers an empty set when no widget is registered (never an error)', async () => {
    const useCase = new GetCommandCenterUseCase(auth(new Set(['reports.read'])), [], []);
    const result = await useCase.execute({ principal: viewer });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.widgets).toEqual([]);
      expect(result.value.actions).toEqual([]);
    }
  });

  it('returns only the actions whose permission the viewer holds (hides the rest)', async () => {
    const actions: CommandActionDescriptor[] = [
      { id: 'publish.communities', title: 'نشر', requiredPermission: 'messaging.send' },
      { id: 'accounts.admin', title: 'الحسابات', requiredPermission: 'users.manage' },
    ];
    // Holds reports.read + messaging.send, but NOT users.manage.
    const useCase = new GetCommandCenterUseCase(
      auth(new Set(['reports.read', 'messaging.send'])),
      [],
      actions,
    );

    const result = await useCase.execute({ principal: viewer });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.actions.map((a) => a.id)).toEqual(['publish.communities']);
      // No requiredPermission is dropped here — that is the response's job — but
      // a hidden action never appears at all.
      expect(result.value.actions.some((a) => a.id === 'accounts.admin')).toBe(false);
    }
  });
});

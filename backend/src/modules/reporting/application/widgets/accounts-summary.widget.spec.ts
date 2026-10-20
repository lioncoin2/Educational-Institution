import type {
  AccountDirectorySummary,
  AccountStatusCounts,
} from '../../../identity/contracts/account-directory-summary';
import { AccountsSummaryWidget } from './accounts-summary.widget';

function summaryWith(counts: AccountStatusCounts): AccountDirectorySummary {
  return { summarize: async () => counts };
}

describe('AccountsSummaryWidget', () => {
  it('describes itself for users.manage, in the "today" category', () => {
    const widget = new AccountsSummaryWidget(
      summaryWith({ total: 0, active: 0, pending: 0, suspended: 0, disabled: 0 }),
    );
    expect(widget.descriptor).toMatchObject({
      id: 'accounts.summary',
      category: 'today',
      requiredPermission: 'users.manage',
    });
  });

  it('maps the account tally to metrics', async () => {
    const widget = new AccountsSummaryWidget(
      summaryWith({ total: 12, active: 9, pending: 2, suspended: 1, disabled: 0 }),
    );

    const data = await widget.resolve();

    expect(data.widgetId).toBe('accounts.summary');
    expect(data.payload).toEqual({
      metrics: [
        { key: 'total', label: 'إجمالي الحسابات', value: 12 },
        { key: 'active', label: 'نشطة', value: 9 },
        { key: 'pending', label: 'قيد التفعيل', value: 2 },
        { key: 'suspended', label: 'موقوفة', value: 1 },
        { key: 'disabled', label: 'معطّلة', value: 0 },
      ],
    });
  });
});

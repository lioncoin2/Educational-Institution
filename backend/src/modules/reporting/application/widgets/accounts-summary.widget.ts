import { Inject, Injectable } from '@nestjs/common';

import {
  ACCOUNT_DIRECTORY_SUMMARY,
  type AccountDirectorySummary,
} from '../../../identity/contracts/account-directory-summary';
import { Permissions } from '../../../identity/contracts/permissions';
import type { WidgetData, WidgetDescriptor, WidgetProvider } from '../../contracts';

/**
 * Owner Command Center — accounts summary. FACTS only: how many accounts exist
 * and in what state (active / pending / suspended / disabled), read from
 * identity's aggregate tally — never a listing, never a person. A viewer sees
 * this widget only if they already hold `users.manage` (the owner/admin
 * "is an administrator" marker; reporting filters). No metric is invented.
 */
@Injectable()
export class AccountsSummaryWidget implements WidgetProvider {
  constructor(
    @Inject(ACCOUNT_DIRECTORY_SUMMARY) private readonly accounts: AccountDirectorySummary,
  ) {}

  readonly descriptor: WidgetDescriptor = {
    id: 'accounts.summary',
    category: 'today',
    title: 'الحسابات',
    requiredPermission: Permissions.users.manage,
  };

  async resolve(): Promise<WidgetData> {
    const counts = await this.accounts.summarize();
    return {
      widgetId: this.descriptor.id,
      payload: {
        metrics: [
          { key: 'total', label: 'إجمالي الحسابات', value: counts.total },
          { key: 'active', label: 'نشطة', value: counts.active },
          { key: 'pending', label: 'قيد التفعيل', value: counts.pending },
          { key: 'suspended', label: 'موقوفة', value: counts.suspended },
          { key: 'disabled', label: 'معطّلة', value: counts.disabled },
        ],
      },
    };
  }
}

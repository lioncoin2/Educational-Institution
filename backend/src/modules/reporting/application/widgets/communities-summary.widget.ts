import { Inject, Injectable } from '@nestjs/common';

import {
  COMMUNITY_MEMBERSHIP,
  MAX_MEMBER_PAGE,
  type CommunityMembership,
} from '../../../communities/contracts/membership';
import { Permissions } from '../../../identity/contracts/permissions';
import type { WidgetData, WidgetDescriptor, WidgetProvider } from '../../contracts';

/**
 * Owner Command Center — communities summary. FACTS only: how many communities
 * exist, and how many accept new members now. Both are read from the existing
 * membership contract by keyset-paging every head; nothing is invented, no
 * policy is stated, and no community is loaded whole. A viewer sees this widget
 * only if they already hold `communities.read` (reporting filters).
 */
@Injectable()
export class CommunitiesSummaryWidget implements WidgetProvider {
  constructor(@Inject(COMMUNITY_MEMBERSHIP) private readonly membership: CommunityMembership) {}

  readonly descriptor: WidgetDescriptor = {
    id: 'communities.summary',
    category: 'today',
    title: 'المجتمعات',
    requiredPermission: Permissions.communities.read,
  };

  async resolve(): Promise<WidgetData> {
    let total = 0;
    let acceptingMembers = 0;
    let after: string | undefined;
    // Every community head, one keyset page at a time — a count, never a load.
    for (;;) {
      const page = await this.membership.listHeads({
        afterCommunityId: after,
        limit: MAX_MEMBER_PAGE,
      });
      for (const head of page.items) {
        total += 1;
        if (head.effects.acceptsMembers) acceptingMembers += 1;
      }
      if (page.next === null) break;
      after = page.next;
    }
    return {
      widgetId: this.descriptor.id,
      payload: {
        metrics: [
          { key: 'total', label: 'إجمالي المجتمعات', value: total },
          { key: 'accepting', label: 'تقبل أعضاءً جُددًا', value: acceptingMembers },
        ],
      },
    };
  }
}

import type { CommunityHead, CommunityMembership } from '../../../communities/contracts/membership';
import { CommunitiesSummaryWidget } from './communities-summary.widget';

function head(id: string, acceptsMembers: boolean): CommunityHead {
  return {
    communityId: id,
    membershipVersion: 1,
    lifecycleVersion: 1,
    effects: {
      acceptsMembers,
      chatReadable: true,
      chatPostingOpen: acceptsMembers,
      liveStartOpen: acceptsMembers,
      liveJoinOpen: true,
      runningLiveContinues: true,
    },
  };
}

/** A membership that pages `listHeads` in fixed chunks of two, to exercise the
 * widget's keyset loop with a small, deterministic fixture. */
function membershipWith(heads: readonly CommunityHead[]): CommunityMembership {
  const sorted = [...heads].sort((a, b) => a.communityId.localeCompare(b.communityId));
  return {
    listHeads: async ({ afterCommunityId }: { afterCommunityId?: string; limit: number }) => {
      const start = afterCommunityId
        ? sorted.findIndex((h) => h.communityId === afterCommunityId) + 1
        : 0;
      const chunk = sorted.slice(start, start + 2);
      const lastIndex = start + chunk.length - 1;
      const more = chunk.length > 0 && lastIndex < sorted.length - 1;
      return { items: chunk, next: more ? sorted[lastIndex].communityId : null };
    },
  } as unknown as CommunityMembership;
}

describe('CommunitiesSummaryWidget', () => {
  it('describes itself for communities.read, in the "today" category', () => {
    const widget = new CommunitiesSummaryWidget(membershipWith([]));
    expect(widget.descriptor).toMatchObject({
      id: 'communities.summary',
      category: 'today',
      requiredPermission: 'communities.read',
    });
  });

  it('counts total communities and those accepting members, across pages', async () => {
    const widget = new CommunitiesSummaryWidget(
      membershipWith([head('c1', true), head('c2', false), head('c3', true)]),
    );

    const data = await widget.resolve();

    expect(data.widgetId).toBe('communities.summary');
    expect(data.payload).toEqual({
      metrics: [
        { key: 'total', label: 'إجمالي المجتمعات', value: 3 },
        { key: 'accepting', label: 'تقبل أعضاءً جُددًا', value: 2 },
      ],
    });
  });

  it('answers zeros for an institution with no communities', async () => {
    const widget = new CommunitiesSummaryWidget(membershipWith([]));
    const data = await widget.resolve();
    expect(data.payload).toEqual({
      metrics: [
        { key: 'total', label: 'إجمالي المجتمعات', value: 0 },
        { key: 'accepting', label: 'تقبل أعضاءً جُددًا', value: 0 },
      ],
    });
  });
});

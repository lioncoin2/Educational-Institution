import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared';
import {
  COMMUNITY_MEMBERSHIP,
  type CommunityMembership,
} from '../../communities/contracts/membership';
import { MAX_APPLY_BATCH, type CommunityMemberState } from '../domain/community-chat';
import {
  MESSAGING_READ_MODEL,
  MESSAGING_REPOSITORY,
  type CommunityChatRef,
  type MessagingReadModel,
  type MessagingRepository,
} from '../domain/ports';
import { memberStateOf } from './community-calls';
import { CommunityChatSync } from './community-chat-sync';

export interface ReconcileReport {
  readonly communityId: string;
  readonly conversationId: string;
  /** The projected version found, and the head it was reset to. */
  readonly projectedBefore: number;
  readonly head: number;
  /** Rows compared with the authority, and rows rewritten to match it. */
  readonly examined: number;
  readonly rewritten: number;
}

/**
 * Rebuilds a community chat's projection from the authority
 * (community-chat.md §7.5, §7.6) — for when the projection is AHEAD of
 * Communities, which happens only when Communities was restored from a
 * backup: versions the projection holds were lost and will be allocated
 * again to other changes.
 *
 * With the community's head H read first, it merge-joins the two sides by
 * user id, a page of at most 1,000 at a time:
 *
 *   1. the projection's current members, and every row above H (a row the
 *      authority's next versions could not outrank), each compared with the
 *      authority's latest stint (`statesOf`);
 *   2. the authority's current members (`members`) the projection does not
 *      show as current.
 *
 * Each difference is written with the override — the one writer allowed to
 * lower a row's version; someone the authority no longer knows at all
 * becomes a tombstone at H. Then the projected version is reset to H, and a
 * sync pulls whatever committed during the rebuild: anything the override
 * wrote over is newer than H, so it is pulled again. Access stays correct
 * throughout, because every request asks Communities; fan-out stays correct,
 * because the versions differ until the reset and the lag filter holds.
 *
 * Derived state: a warning and a metric, never an audit entry. The cost is
 * proportional to the community's size — about 30 + 30 pages at 30,000.
 */
@Injectable()
export class CommunityChatReconciler {
  private readonly logger = new Logger(CommunityChatReconciler.name);
  private runs = 0;

  constructor(
    @Inject(COMMUNITY_MEMBERSHIP) private readonly membership: CommunityMembership,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    private readonly sync: CommunityChatSync,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Rebuilds run so far — for tests and metrics. */
  get reconciliations(): number {
    return this.runs;
  }

  /** Null when there is nothing to rebuild: no chat, or no such community. */
  async reconcile(communityId: string): Promise<ReconcileReport | null> {
    const chat = await this.readModel.communityChat(communityId);
    if (chat === null) return null;
    const [head] = await this.membership.heads([communityId]);
    // An orphan: every access is refused and every recipient page empty.
    if (head === undefined) return null;
    this.runs += 1;
    const version = head.membershipVersion;
    let examined = 0;
    let rewritten = 0;

    let after: string | undefined;
    do {
      const page = await this.readModel.projectionRows(chat.conversationId, {
        limit: MAX_APPLY_BATCH,
        afterUserId: after,
        versionAbove: version,
      });
      examined += page.items.length;
      if (page.items.length > 0) {
        const truth = new Map(
          (
            await this.membership.statesOf(
              communityId,
              page.items.map((row) => row.userId),
            )
          ).map((state) => [state.userId, state]),
        );
        const fixes: CommunityMemberState[] = [];
        for (const row of page.items) {
          const state = truth.get(row.userId);
          if (state !== undefined) {
            if (
              state.version !== row.sourceVersion ||
              state.active !== row.active ||
              state.membershipId !== row.sourceMembershipId
            ) {
              fixes.push(memberStateOf(state));
            }
          } else if (row.sourceMembershipId !== null && row.sourceJoinedAt !== null) {
            // No stint at all any more: not a member — a tombstone at the
            // head, which anything the authority allocates next outranks.
            fixes.push({
              userId: row.userId,
              membershipId: row.sourceMembershipId,
              active: false,
              joinedAt: row.sourceJoinedAt,
              version: Math.max(version, 1),
            });
          }
        }
        rewritten += await this.write(chat, fixes);
      }
      after = page.next ?? undefined;
    } while (after !== undefined);

    let cursor: string | null = null;
    do {
      const page = await this.membership.members(communityId, { cursor, limit: MAX_APPLY_BATCH });
      if (page.userIds.length > 0) {
        const projected = await this.readModel.listMemberIds(chat.conversationId, {
          limit: MAX_APPLY_BATCH,
          onlyUserIds: page.userIds,
        });
        const present = new Set(projected.userIds);
        const missing = page.userIds.filter((userId) => !present.has(userId));
        examined += missing.length;
        if (missing.length > 0) {
          const states = await this.membership.statesOf(communityId, missing);
          rewritten += await this.write(
            chat,
            states.filter((state) => state.active).map(memberStateOf),
          );
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    await this.repository.resetProjectedVersion(chat.conversationId, version);
    this.sync.schedule(communityId);

    const report: ReconcileReport = {
      communityId,
      conversationId: chat.conversationId,
      projectedBefore: chat.projectedVersion,
      head: version,
      examined,
      rewritten,
    };
    this.logger.warn(report, 'community chat projection rebuilt from Communities');
    return report;
  }

  private async write(
    chat: CommunityChatRef,
    states: readonly CommunityMemberState[],
  ): Promise<number> {
    if (states.length === 0) return 0;
    await this.repository.applyCommunityMembership({
      conversationId: chat.conversationId,
      states,
      advance: null,
      override: true,
      at: this.clock.now(),
    });
    return states.length;
  }
}

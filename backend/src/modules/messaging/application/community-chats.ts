import { Inject, Injectable, Logger } from '@nestjs/common';

import { err, ok, type Principal, type Result } from '../../../shared';
import {
  COMMUNITY_AUTHORIZATION,
  type CommunityAuthorization,
} from '../../communities/contracts/authorization';
import {
  COMMUNITY_DIRECTORY,
  type CommunityDirectory,
} from '../../communities/contracts/directory';
import type { Conversation } from '../domain/conversation';
import type { ConversationSummaryRow } from '../domain/ports';
import { askCommunities } from './community-calls';
import {
  COMMUNITY_CHAT_OVER_CAPACITY,
  COMMUNITY_CHAT_POSTING_NOT_ALLOWED,
  COMMUNITY_CHAT_SETTINGS,
  type CommunityChatSettings,
} from './community-chat-settings';
import { CommunityChatSync } from './community-chat-sync';
import { CONVERSATION_NOT_FOUND, ConversationAccess } from './conversation-access';

/** How a community chat is shown: its community's title, and whether the viewer may post now. */
export interface CommunityChatDetails {
  readonly title: string | null;
  readonly canPost: boolean;
}

/**
 * What a community chat asks of Communities beyond reading it
 * (community-chat.md §7.2, §7.4, §11.2): whether someone may post, which
 * chats a list may show, and how they are shown. Every answer is
 * Communities' own — messaging keeps no copy of posting rights, locks or
 * titles — and a list page costs a fixed number of calls, however many
 * community chats it holds.
 */
@Injectable()
export class CommunityChats {
  private readonly logger = new Logger(CommunityChats.name);

  constructor(
    @Inject(COMMUNITY_AUTHORIZATION) private readonly authorization: CommunityAuthorization,
    @Inject(COMMUNITY_DIRECTORY) private readonly directory: CommunityDirectory,
    @Inject(COMMUNITY_CHAT_SETTINGS) private readonly settings: CommunityChatSettings,
    private readonly access: ConversationAccess,
    private readonly sync: CommunityChatSync,
  ) {}

  /**
   * A send's community checks, after the read branch admitted the sender:
   * the `community.chat.post` permit — the owner, or a delegated poster,
   * and never while the lifecycle closes posting — then the capacity switch.
   * The client's opinion of `canPost` is never consulted.
   */
  async mayPost(principal: Principal, conversation: Conversation): Promise<Result<void>> {
    if (conversation.communityId === null) throw new Error('Not a community chat.');
    const permit = await this.access.communityPermit(
      principal,
      conversation.communityId,
      'community.chat.post',
    );
    if (!permit.ok) {
      switch (permit.error.kind) {
        case 'unavailable':
          return permit;
        // Removed since the read permit: the same answer as any non-member.
        case 'not_found':
          return err(CONVERSATION_NOT_FOUND);
        // No capability, a missing identity ceiling, or posting closed (LOCKED).
        default:
          return err(COMMUNITY_CHAT_POSTING_NOT_ALLOWED);
      }
    }
    if (this.overCapacity(conversation)) return err(COMMUNITY_CHAT_OVER_CAPACITY);
    return ok(undefined);
  }

  /**
   * The rows of a list page the caller may still see: the page's community
   * chats re-asked of Communities in ONE call. A refused one is dropped —
   * its row is stale — and its community synced.
   */
  async readable(
    principal: Principal,
    rows: readonly ConversationSummaryRow[],
  ): Promise<Result<ConversationSummaryRow[]>> {
    const communityIds = communityIdsOf(rows);
    if (communityIds.length === 0) return ok([...rows]);
    const answers = await askCommunities(this.logger, () =>
      this.authorization.authorizeEach(principal, communityIds, 'community.chat.read'),
    );
    if (!answers.ok) return answers;
    const refused = new Set(communityIds.filter((id) => answers.value.get(id)?.ok !== true));
    for (const communityId of refused) this.sync.schedule(communityId);
    return ok(
      rows.filter(
        (row) =>
          row.conversation.communityId === null || !refused.has(row.conversation.communityId),
      ),
    );
  }

  /**
   * Titles and posting rights for the community chats among rows the caller
   * may read — one `authorizeEach` and one `describe`, whatever their number,
   * and none when there are none.
   */
  async details(
    principal: Principal,
    rows: readonly ConversationSummaryRow[],
  ): Promise<Result<ReadonlyMap<string, CommunityChatDetails>>> {
    const communityIds = communityIdsOf(rows);
    if (communityIds.length === 0) return ok(new Map());
    const answers = await askCommunities(this.logger, () =>
      Promise.all([
        this.authorization.authorizeEach(principal, communityIds, 'community.chat.post'),
        this.directory.describe(communityIds),
      ]),
    );
    if (!answers.ok) return answers;
    const [posting, summaries] = answers.value;
    const titles = new Map(summaries.map((summary) => [summary.communityId, summary.title]));
    const details = new Map<string, CommunityChatDetails>();
    for (const { conversation } of rows) {
      if (conversation.communityId === null) continue;
      details.set(conversation.id, {
        title: titles.get(conversation.communityId) ?? null,
        canPost:
          posting.get(conversation.communityId)?.ok === true && !this.overCapacity(conversation),
      });
    }
    return ok(details);
  }

  /** The capacity switch (§11.2), against messaging's own projected count. */
  private overCapacity(conversation: Conversation): boolean {
    return conversation.memberCount > this.settings.maxServedMembers;
  }
}

function communityIdsOf(rows: readonly ConversationSummaryRow[]): string[] {
  return [
    ...new Set(
      rows.flatMap((row) =>
        row.conversation.communityId === null ? [] : [row.conversation.communityId],
      ),
    ),
  ];
}

import { Inject, Injectable, Logger } from '@nestjs/common';

import { err, ok, type Principal, type Result } from '../../../shared';
import {
  COMMUNITY_AUTHORIZATION,
  type CommunityAuthorization,
  type CommunityPermit,
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
import { MESSAGE_MODERATION_FORBIDDEN } from './messaging-settings';

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
   * A moderation request's community check (Q51/Q23, ADR 0029): the
   * `community.messages.moderate` permit — the owner implicitly, or a member
   * the owner delegated it to — asked of Communities NOW. It never consults the
   * projected participant rows and never asks `community.chat.read`: moderation
   * authority is the moderator's own community standing, and reading the chat
   * is neither implied by it nor required for it. The winning permit comes back
   * so the caller can audit which standing authorized the delete or the review.
   *
   *   unavailable  503, as it came — Communities could not answer
   *   not_found    an unknown community or a non-member: the 404 a non-member
   *                always hears, so moderation is no enumeration surface
   *   otherwise    a member without the capability, or no identity ceiling (a
   *                student has no `communities.moderate`): "you may not
   *                moderate here" (403). A lock never reaches here — the act's
   *                gate is `always`.
   */
  async mayModerate(
    principal: Principal,
    conversation: Conversation,
  ): Promise<Result<CommunityPermit>> {
    if (conversation.communityId === null) throw new Error('Not a community chat.');
    const permit = await this.access.communityPermit(
      principal,
      conversation.communityId,
      'community.messages.moderate',
    );
    if (permit.ok) return permit;
    switch (permit.error.kind) {
      case 'unavailable':
        return permit;
      case 'not_found':
        return err(CONVERSATION_NOT_FOUND);
      default:
        return err(MESSAGE_MODERATION_FORBIDDEN);
    }
  }

  /**
   * The rows of a list page the caller may still see: the page's community
   * chats re-asked of Communities in ONE call. A refused one is dropped —
   * its row is stale — and its community synced.
   *
   * When Communities cannot answer, every community chat on the page is
   * dropped — its row alone is never an answer (§19) — and the rest of the
   * page is served: the caller's other conversations never depend on
   * Communities. They are back on the next read once it answers again.
   */
  async readable(
    principal: Principal,
    rows: readonly ConversationSummaryRow[],
  ): Promise<ConversationSummaryRow[]> {
    const communityIds = communityIdsOf(rows);
    if (communityIds.length === 0) return [...rows];
    const answers = await askCommunities(this.logger, () =>
      this.authorization.authorizeEach(principal, communityIds, 'community.chat.read'),
    );
    if (!answers.ok) return rows.filter((row) => row.conversation.communityId === null);
    const refused = new Set(communityIds.filter((id) => answers.value.get(id)?.ok !== true));
    for (const communityId of refused) this.sync.schedule(communityId);
    return rows.filter(
      (row) => row.conversation.communityId === null || !refused.has(row.conversation.communityId),
    );
  }

  /**
   * Titles and posting rights for the community chats among rows the caller
   * may read — one `authorizeEach` and one `describe`, whatever their number,
   * and none when there are none. When Communities cannot answer, none: each
   * such chat is shown with the views' fail-closed default — no title, and
   * no posting (a send would be refused with 503 anyway).
   */
  async details(
    principal: Principal,
    rows: readonly ConversationSummaryRow[],
  ): Promise<ReadonlyMap<string, CommunityChatDetails>> {
    const communityIds = communityIdsOf(rows);
    if (communityIds.length === 0) return new Map();
    const answers = await askCommunities(this.logger, () =>
      Promise.all([
        this.authorization.authorizeEach(principal, communityIds, 'community.chat.post'),
        this.directory.describe(communityIds),
      ]),
    );
    if (!answers.ok) return new Map();
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
    return details;
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

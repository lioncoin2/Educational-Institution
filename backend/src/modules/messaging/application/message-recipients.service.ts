import { Inject, Injectable } from '@nestjs/common';

import { COMMUNITY_CHAT_READ_CEILING } from '../../communities/contracts/capabilities';
import {
  COMMUNITY_MEMBERSHIP,
  type CommunityMembership,
} from '../../communities/contracts/membership';
import {
  ACCOUNT_DIRECTORY,
  type AccountDirectory,
} from '../../identity/contracts/account-directory';
import { Permissions, type Permission } from '../../identity/contracts/permissions';
import {
  MAX_RECIPIENT_PAGE,
  type MessageRecipients,
  type RecipientPage,
} from '../contracts/message-recipients';
import type { Conversation, ConversationId } from '../domain/conversation';
import {
  MESSAGING_READ_MODEL,
  MESSAGING_REPOSITORY,
  type MessagingReadModel,
  type MessagingRepository,
} from '../domain/ports';
import { CommunityChatSync } from './community-chat-sync';
import { decodeMemberCursor, encodeMemberCursor } from './cursors';

type ListOptions = Parameters<MessageRecipients['list']>[1];

const NOBODY: RecipientPage = { userIds: [], nextCursor: null };

/**
 * Current members of a conversation, for delivery modules. Ids only: what a
 * notification says, and to whom it may show a preview, is decided where the
 * message can be read — here, through the use cases — not in the fan-out.
 *
 * No principal: this answers trusted in-process code (the event subscribers),
 * never a request, and it discloses nothing but membership.
 *
 * `readersOnly` narrows a page to the members who may read the conversation
 * now — asked of identity through the account directory, the same way
 * messaging decides who may be added as a reader. A page may therefore hold
 * fewer ids than its limit; the cursor still continues after the last member
 * examined, so nobody is skipped or seen twice.
 *
 * A community chat's page (community-chat.md §7.3) comes from the projection
 * and is then narrowed, never widened:
 *
 *   community unknown, or its chat unreadable   an empty page
 *   projection behind (or ahead of) the head    only those Communities reports
 *                                                ACTIVE now; a sync is scheduled
 *   always, whatever `readersOnly` says         only accounts holding EVERY
 *                                                permission of COMMUNITY_CHAT_READ_CEILING
 *
 * So a member Communities removed, or one whose role lost part of the read
 * ceiling, gets no frame and no notification — exactly as they get 404 over
 * HTTP. A member joined but not yet projected is missed until the sync runs:
 * that fails closed, and they read the message over HTTP.
 */
@Injectable()
export class MessageRecipientsService implements MessageRecipients {
  constructor(
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(COMMUNITY_MEMBERSHIP) private readonly membership: CommunityMembership,
    private readonly sync: CommunityChatSync,
  ) {}

  async list(conversationId: string, options: ListOptions): Promise<RecipientPage> {
    const after = decodeMemberCursor(options.cursor);
    if (!after.ok) throw new RangeError('Invalid recipient cursor.');
    if (options.onlyUserIds !== undefined && options.onlyUserIds.length > MAX_RECIPIENT_PAGE) {
      throw new RangeError(`At most ${MAX_RECIPIENT_PAGE} users may be named at once.`);
    }
    const id = conversationId as ConversationId;
    const conversation = await this.repository.findConversation(id);
    if (conversation === null) return NOBODY;
    if (conversation.communityId !== null) {
      return this.communityPage(conversation, conversation.communityId, after.value, options);
    }

    const page = await this.page(id, after.value, options);
    return {
      userIds:
        options.readersOnly === true
          ? await this.holdingAll(page.userIds, [Permissions.messaging.read])
          : page.userIds,
      nextCursor: page.next === null ? null : encodeMemberCursor(page.next),
    };
  }

  private async communityPage(
    conversation: Conversation,
    communityId: string,
    afterUserId: string | undefined,
    options: ListOptions,
  ): Promise<RecipientPage> {
    const [head] = await this.membership.heads([communityId]);
    if (head === undefined || !head.effects.chatReadable) return NOBODY;

    const page = await this.page(conversation.id, afterUserId, options);
    let userIds = page.userIds;
    if (conversation.projectedMembershipVersion !== head.membershipVersion) {
      this.sync.schedule(communityId);
      if (userIds.length > 0) {
        const active = new Set(
          (await this.membership.statesOf(communityId, userIds))
            .filter((state) => state.active)
            .map((state) => state.userId),
        );
        userIds = userIds.filter((userId) => active.has(userId));
      }
    }
    return {
      userIds: await this.holdingAll(userIds, COMMUNITY_CHAT_READ_CEILING),
      nextCursor: page.next === null ? null : encodeMemberCursor(page.next),
    };
  }

  private page(
    conversationId: ConversationId,
    afterUserId: string | undefined,
    options: ListOptions,
  ) {
    return this.readModel.listMemberIds(conversationId, {
      limit: Math.max(1, Math.min(options.limit, MAX_RECIPIENT_PAGE)),
      afterUserId,
      excludeUserId: options.excludeUserId,
      visibleSequence: options.visibleSequence,
      onlyUserIds: options.onlyUserIds,
    });
  }

  /** The ids, in order, whose ACTIVE accounts hold every one of these permissions. */
  private async holdingAll(
    userIds: readonly string[],
    permissions: readonly Permission[],
  ): Promise<readonly string[]> {
    let kept = userIds;
    for (const permission of permissions) {
      if (kept.length === 0) return kept;
      const allowed = await this.directory.withPermission(kept, permission);
      kept = kept.filter((userId) => allowed.has(userId));
    }
    return kept;
  }
}

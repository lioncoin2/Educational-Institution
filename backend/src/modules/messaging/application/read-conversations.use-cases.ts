import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Principal, type Result } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import type { ConversationId } from '../domain/conversation';
import { MESSAGING_READ_MODEL, type MessagingReadModel } from '../domain/ports';
import { COMMUNITY_CHAT_MEMBERS_HIDDEN } from './community-chat-settings';
import { CommunityChats } from './community-chats';
import { CONVERSATION_NOT_FOUND, ConversationAccess } from './conversation-access';
import {
  decodeConversationCursor,
  decodeMemberCursor,
  encodeConversationCursor,
  encodeMemberCursor,
} from './cursors';
import { PAGE_LIMITS, pageLimit } from './messaging-settings';
import { MessagingViews } from './messaging-views';
import type { ConversationView, MessagePage, ParticipantView } from './views';

/**
 * The caller's own DIRECT conversations, most recently active first. There is
 * no parameter that widens this to anyone else's — the query starts from the
 * caller's memberships and never leaves them.
 *
 * This is the Messages list, and it is direct conversations only. Community
 * group and channel chats are NOT listed here: they belong to Communities and
 * are opened through its own chat endpoint (`communityChat` /
 * `conversationForCommunity`). The read model is asked for `type = 'DIRECT'`,
 * so a non-direct conversation can never reach this page. The community-chat
 * readability pass below is retained as a defensive projection (and still
 * backs `GetConversationUseCase` through the shared helper); on a direct-only
 * page it is a no-op, since direct conversations carry no `communityId`.
 */
@Injectable()
export class ListConversationsUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    private readonly views: MessagingViews,
    private readonly communityChats: CommunityChats,
  ) {}

  async execute(query: {
    readonly principal: Principal;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<{ items: ConversationView[]; nextCursor: string | null }>> {
    const allowed = this.access.authorize(query.principal, Permissions.messaging.read);
    if (!allowed.ok) return allowed;
    const after = decodeConversationCursor(query.cursor);
    if (!after.ok) return after;

    const page = await this.readModel.listConversations(query.principal.userId, {
      limit: pageLimit(query.limit, PAGE_LIMITS.conversations),
      after: after.value,
      // Direct conversations only: community group/channel chats are reached
      // through Communities, never listed in Messages.
      types: ['DIRECT'],
    });
    const readable = await this.communityChats.readable(query.principal, page.items);
    const details = await this.communityChats.details(query.principal, readable);
    return ok({
      items: await this.views.conversations(readable, details),
      nextCursor: page.next === null ? null : encodeConversationCursor(page.next),
    });
  }
}

/**
 * One conversation as its member sees it — also what realtime `subscribe`
 * asks, through MESSAGE_DELIVERY.position. It passes the access checkpoint
 * first, so a community chat is asked of Communities (and the caller's row
 * repaired if behind) before the summary is read.
 */
@Injectable()
export class GetConversationUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    private readonly views: MessagingViews,
    private readonly communityChats: CommunityChats,
  ) {}

  async execute(query: {
    readonly principal: Principal;
    readonly conversationId: string;
  }): Promise<Result<ConversationView>> {
    const membership = await this.access.member(
      query.principal,
      query.conversationId,
      Permissions.messaging.read,
    );
    if (!membership.ok) return membership;
    return this.view(query.principal, membership.value.conversation.id);
  }

  /** The summary of a conversation the caller was just admitted to. */
  async view(
    principal: Principal,
    conversationId: ConversationId,
  ): Promise<Result<ConversationView>> {
    // The summary query itself is scoped to the caller's current membership.
    const row = await this.readModel.conversationSummary(conversationId, principal.userId);
    if (row === null) return err(CONVERSATION_NOT_FOUND);
    const details = await this.communityChats.details(principal, [row]);
    const [view] = await this.views.conversations([row], details);
    return view === undefined ? err(CONVERSATION_NOT_FOUND) : ok(view);
  }
}

/**
 * A page of the timeline, by sequence:
 *
 *   neither cursor   the latest messages
 *   before=S         the messages just older than S (scrolling back)
 *   after=S          the messages just newer than S (catching up)
 *
 * Only messages inside the caller's visibility window are ever returned, and
 * deleted ones come back as tombstones, so positions never shift.
 */
@Injectable()
export class ListMessagesUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    private readonly views: MessagingViews,
  ) {}

  async execute(query: {
    readonly principal: Principal;
    readonly conversationId: string;
    readonly before?: number;
    readonly after?: number;
    readonly limit?: number;
  }): Promise<Result<MessagePage>> {
    if (query.before !== undefined && query.after !== undefined) {
      return err(
        failure('validation', 'messaging.cursor_invalid', 'Use either before or after, not both.'),
      );
    }
    for (const cursor of [query.before, query.after]) {
      if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) {
        return err(failure('validation', 'messaging.cursor_invalid', 'That cursor is not valid.'));
      }
    }

    const membership = await this.access.member(
      query.principal,
      query.conversationId,
      Permissions.messaging.read,
    );
    if (!membership.ok) return membership;
    const { conversation, participant } = membership.value;

    const slice = await this.readModel.listMessages(conversation.id, {
      hiddenThroughSequence: participant.hiddenThroughSequence,
      lastSequence: conversation.lastSequence,
      before: query.before,
      after: query.after,
      limit: pageLimit(query.limit, PAGE_LIMITS.messages),
    });
    const rendered = await this.views.messages(slice.items, query.principal.userId);
    return ok({
      items: rendered.items,
      hasOlder: slice.hasOlder,
      hasNewer: slice.hasNewer,
      lastReadSequence: participant.lastReadSequence,
      senders: rendered.senders,
    });
  }
}

/**
 * A conversation's member list is available only to administrators (Q22).
 */
const MEMBERS_ADMIN_ONLY = failure(
  'forbidden',
  'messaging.members_hidden',
  "A conversation's member list is available only to administrators.",
);

/**
 * Who is in a conversation. The member list is an administrative view: only
 * the institution owner and top-level administration (`users.manage`) may read
 * it (Q22). Taking part in a conversation — even owning it, publishing to a
 * channel, teaching, or managing a community — never grants the roster; that
 * is a deliberate separation from reading messages, sending, and managing
 * participants, each decided on its own. A community chat's members are never
 * listed here, by anyone: the roster is Communities' (`community.members.view`).
 */
@Injectable()
export class ListParticipantsUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    private readonly views: MessagingViews,
  ) {}

  async execute(query: {
    readonly principal: Principal;
    readonly conversationId: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<{ items: ParticipantView[]; nextCursor: string | null }>> {
    const membership = await this.access.member(
      query.principal,
      query.conversationId,
      Permissions.messaging.read,
    );
    if (!membership.ok) return membership;
    const { conversation } = membership.value;
    if (conversation.communityId !== null) return err(COMMUNITY_CHAT_MEMBERS_HIDDEN);
    // Q22: only the owner and top-level administration (`users.manage`, held by
    // owner and admin alone) may see who is in a conversation. Membership, the
    // conversation OWNER role, a channel PUBLISHER, teaching and community
    // management grant no access to the roster.
    if (!this.access.can(query.principal, Permissions.users.manage)) {
      return err(MEMBERS_ADMIN_ONLY);
    }

    const after = decodeMemberCursor(query.cursor);
    if (!after.ok) return after;
    const page = await this.readModel.listParticipants(conversation.id, {
      limit: pageLimit(query.limit, PAGE_LIMITS.participants),
      afterUserId: after.value,
    });
    return ok({
      items: await this.views.participants(page.items),
      nextCursor: page.next === null ? null : encodeMemberCursor(page.next),
    });
  }
}

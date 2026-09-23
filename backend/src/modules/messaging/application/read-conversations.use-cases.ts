import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Principal, type Result } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import type { ConversationId } from '../domain/conversation';
import { canManageMembers } from '../domain/participant';
import { MESSAGING_READ_MODEL, type MessagingReadModel } from '../domain/ports';
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
 * The caller's own conversations, most recently active first. There is no
 * parameter that widens this to anyone else's — the query starts from the
 * caller's memberships and never leaves them.
 */
@Injectable()
export class ListConversationsUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    private readonly views: MessagingViews,
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
    });
    return ok({
      items: await this.views.conversations(page.items),
      nextCursor: page.next === null ? null : encodeConversationCursor(page.next),
    });
  }
}

@Injectable()
export class GetConversationUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    private readonly views: MessagingViews,
  ) {}

  async execute(query: {
    readonly principal: Principal;
    readonly conversationId: string;
  }): Promise<Result<ConversationView>> {
    const allowed = this.access.authorize(
      query.principal,
      Permissions.messaging.read,
      query.conversationId,
    );
    if (!allowed.ok) return allowed;
    // The summary query itself is scoped to the caller's current membership.
    const row = await this.readModel.conversationSummary(
      query.conversationId as ConversationId,
      query.principal.userId,
    );
    if (row === null) return err(CONVERSATION_NOT_FOUND);
    const [view] = await this.views.conversations([row]);
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
 * Who is in a conversation. In a channel, subscribers do not see one another
 * — a notice board does not publish its readers — so only its owner and
 * publishers may list them (provisional, Q22).
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
    const { conversation, participant } = membership.value;
    if (
      conversation.type === 'CHANNEL' &&
      !canManageMembers(conversation.type, participant.role) &&
      participant.role !== 'PUBLISHER'
    ) {
      return err(
        failure('forbidden', 'messaging.members_hidden', "A channel's members are not listed."),
      );
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

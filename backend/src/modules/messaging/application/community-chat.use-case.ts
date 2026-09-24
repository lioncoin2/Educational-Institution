import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  RATE_LIMITER,
  err,
  failure,
  type Clock,
  type IdGenerator,
  type Principal,
  type RateLimiter,
  type Result,
} from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import {
  MESSAGING_READ_MODEL,
  MESSAGING_REPOSITORY,
  type MessagingReadModel,
  type MessagingRepository,
} from '../domain/ports';
import { COMMUNITY_CHATS_OPENED_PER_USER } from './community-chat-settings';
import { CommunityChatSync } from './community-chat-sync';
import { CONVERSATION_NOT_FOUND, ConversationAccess } from './conversation-access';
import { GetConversationUseCase } from './read-conversations.use-cases';
import type { ConversationView } from './views';

/**
 * A community's chat, opened from the community (community-chat.md §12.1):
 * `GET /messaging/communities/:communityId/conversation`.
 *
 * In order:
 *
 *   1. `messaging.read`, then a per-user rate limit — community ids are not
 *      secrets, and probing them should be slow;
 *   2. Communities' `community.chat.read` permit — an unknown community, a
 *      non-member and an unreadable community all get the same 404, and
 *      nothing is created for any of them;
 *   3. the chat, materialized idempotently if the community has none yet
 *      (any number of concurrent calls give one conversation) — and then
 *      `messaging.read` again, now with the conversation named, as every
 *      conversation-scoped read asks it;
 *   4. the caller's projected row, repaired at once if the projection has
 *      not applied their join yet — so someone who just joined through a
 *      link can read the chat immediately. A projection behind the caller's
 *      own stint is behind for others too: a sync is scheduled.
 *
 * The answer is the ordinary conversation view: typed CHANNEL, with the
 * community's id and title, and `canPost` from Communities.
 */
@Injectable()
export class GetCommunityChatUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    private readonly conversations: GetConversationUseCase,
    private readonly sync: CommunityChatSync,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(query: {
    readonly principal: Principal;
    readonly communityId: string;
  }): Promise<Result<ConversationView>> {
    const { principal, communityId } = query;
    const allowed = this.access.authorize(principal, Permissions.messaging.read);
    if (!allowed.ok) return allowed;
    const throttle = await this.limiter.consume(principal.userId, COMMUNITY_CHATS_OPENED_PER_USER);
    if (!throttle.allowed) {
      return err(
        failure(
          'rate_limited',
          'messaging.too_many_community_chat_lookups',
          'Too many requests. Try again shortly.',
          { retryAfterSeconds: throttle.retryAfterSeconds },
        ),
      );
    }

    const permit = await this.access.communityPermit(principal, communityId, 'community.chat.read');
    if (!permit.ok)
      return permit.error.kind === 'unavailable' ? permit : err(CONVERSATION_NOT_FOUND);

    const known = await this.readModel.communityChat(communityId);
    const stint = permit.value.membership;
    if (known === null || (stint !== null && known.projectedVersion < stint.version)) {
      this.sync.schedule(communityId);
    }
    const conversation =
      known === null
        ? await this.repository.materializeCommunityChat({
            id: this.ids.next<'Conversation'>(),
            communityId,
            at: this.clock.now(),
          })
        : await this.repository.findConversation(known.conversationId);
    if (conversation === null) return err(CONVERSATION_NOT_FOUND);
    const named = this.access.authorize(principal, Permissions.messaging.read, conversation.id);
    if (!named.ok) return named;

    const membership = await this.access.admittedToCommunityChat(
      principal,
      conversation,
      permit.value,
    );
    if (!membership.ok) return membership;
    return this.conversations.view(principal, conversation.id);
  }
}

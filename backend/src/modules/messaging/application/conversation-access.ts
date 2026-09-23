import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Principal, type Result } from '../../../shared';
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import type { Permission } from '../../identity/contracts/permissions';
import type { Conversation, ConversationId } from '../domain/conversation';
import { isActive, type Participant } from '../domain/participant';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { CONVERSATION_RESOURCE } from './messaging-settings';

export const CONVERSATION_NOT_FOUND = failure(
  'not_found',
  'messaging.conversation_not_found',
  'No such conversation.',
);

export interface Membership {
  readonly conversation: Conversation;
  readonly participant: Participant;
}

/**
 * The gate every conversation-scoped use case passes, in this order:
 *
 *   1. the principal holds the permission for the act — `messaging.read`,
 *      `messaging.send`, … — asked of identity, with the conversation named;
 *   2. the principal is a CURRENT member of that conversation.
 *
 * Both, always. A permission is never a pass into conversations one is not
 * in: there is no "may read every conversation" path anywhere in messaging.
 * A conversation that exists but excludes the caller is reported exactly like
 * one that does not exist, so membership cannot be probed.
 */
@Injectable()
export class ConversationAccess {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
  ) {}

  authorize(principal: Principal, permission: Permission, conversationId?: string): Result<void> {
    return this.authorization.authorize(
      principal,
      permission,
      conversationId === undefined
        ? undefined
        : { resourceType: CONVERSATION_RESOURCE, resourceId: conversationId },
    );
  }

  can(principal: Principal, permission: Permission): boolean {
    return this.authorization.can(principal, permission);
  }

  async member(
    principal: Principal,
    conversationId: string,
    permission: Permission,
  ): Promise<Result<Membership>> {
    const allowed = this.authorize(principal, permission, conversationId);
    if (!allowed.ok) return allowed;

    const id = conversationId as ConversationId;
    const participant = await this.repository.findParticipant(id, principal.userId);
    if (!isActive(participant)) return err(CONVERSATION_NOT_FOUND);
    const conversation = await this.repository.findConversation(id);
    if (conversation === null) return err(CONVERSATION_NOT_FOUND);
    return ok({ conversation, participant });
  }
}

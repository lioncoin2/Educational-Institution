import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, err, failure, ok, type Clock, type Principal, type Result } from '../../../shared';
import {
  COMMUNITY_AUTHORIZATION,
  type CommunityAuthorization,
  type CommunityPermit,
} from '../../communities/contracts/authorization';
import type { CommunityAct } from '../../communities/contracts/capabilities';
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import type { Permission } from '../../identity/contracts/permissions';
import type { Conversation, ConversationId } from '../domain/conversation';
import { isActive, type Participant } from '../domain/participant';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { askCommunities } from './community-calls';
import { CommunityChatSync } from './community-chat-sync';
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
 *
 * A community chat (community-chat.md §7.1) answers step 2 differently: its
 * rows are a projection of Communities' membership, never an access answer
 * on their own. So Communities is asked on EVERY request — no cache — for
 * `community.chat.read`, and only then is the caller's row looked at:
 *
 *   refused          404, identical to a missing conversation; a sync is
 *                    scheduled, so a stale row is cleaned up soon
 *   Communities down 503 — never a role-only answer
 *   permitted        the caller's row, repaired first if it is behind the
 *                    permit's stint (a join the projection has not applied
 *                    yet); still not current → 404
 *
 * A removal therefore takes effect when Communities commits it, whatever the
 * projection says. Conversations whose membership messaging manages never
 * reach Communities.
 */
@Injectable()
export class ConversationAccess {
  private readonly logger = new Logger(ConversationAccess.name);

  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(COMMUNITY_AUTHORIZATION) private readonly communities: CommunityAuthorization,
    private readonly sync: CommunityChatSync,
    @Inject(CLOCK) private readonly clock: Clock,
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
    const conversation = await this.repository.findConversation(id);
    if (conversation === null) return err(CONVERSATION_NOT_FOUND);
    if (conversation.communityId !== null) {
      return this.communityMember(principal, conversation, conversation.communityId);
    }
    const participant = await this.repository.findParticipant(id, principal.userId);
    if (!isActive(participant)) return err(CONVERSATION_NOT_FOUND);
    return ok({ conversation, participant });
  }

  /**
   * One act asked of Communities, for this principal in this community. A
   * rejection becomes 503 (`unavailable`); a refusal is returned as it came.
   */
  communityPermit(
    principal: Principal,
    communityId: string,
    act: CommunityAct,
  ): Promise<Result<CommunityPermit>> {
    return askCommunities(this.logger, () =>
      this.communities.authorize(principal, communityId, act),
    ).then((answer) => (answer.ok ? answer.value : answer));
  }

  /**
   * Given a positive `community.chat.read` permit: the caller's projected
   * row, repaired first when it is behind the permit's stint. Repair only
   * ever writes the ACTIVE stint Communities just vouched for — never a
   * leave, which the scheduled sync applies — so a refused read never takes
   * a busy conversation's lock.
   */
  async admittedToCommunityChat(
    principal: Principal,
    conversation: Conversation,
    permit: CommunityPermit,
  ): Promise<Result<Membership>> {
    // Oversight never reads a community's chat (Q43): only a stint admits.
    const stint = permit.membership;
    if (stint === null) return err(CONVERSATION_NOT_FOUND);
    const row = await this.repository.findParticipant(conversation.id, principal.userId);
    if (isActive(row) && (row.sourceVersion ?? 0) >= stint.version) {
      return ok({ conversation, participant: row });
    }
    const applied = await this.repository.applyCommunityMembership({
      conversationId: conversation.id,
      states: [
        {
          userId: principal.userId,
          membershipId: stint.membershipId,
          active: true,
          joinedAt: stint.joinedAt,
          version: stint.version,
        },
      ],
      advance: null,
      at: this.clock.now(),
    });
    if (applied.kind !== 'applied') return err(CONVERSATION_NOT_FOUND);
    const [repaired, current] = await Promise.all([
      this.repository.findParticipant(conversation.id, principal.userId),
      this.repository.findConversation(conversation.id),
    ]);
    // Still not current: a newer leave was applied meanwhile, or the
    // projection carries a newer tombstone (an authority restore, §7.6).
    if (!isActive(repaired) || current === null) return err(CONVERSATION_NOT_FOUND);
    return ok({ conversation: current, participant: repaired });
  }

  private async communityMember(
    principal: Principal,
    conversation: Conversation,
    communityId: string,
  ): Promise<Result<Membership>> {
    const permit = await this.communityPermit(principal, communityId, 'community.chat.read');
    if (!permit.ok) {
      if (permit.error.kind === 'unavailable') return permit;
      this.sync.schedule(communityId);
      return err(CONVERSATION_NOT_FOUND);
    }
    return this.admittedToCommunityChat(principal, conversation, permit.value);
  }
}

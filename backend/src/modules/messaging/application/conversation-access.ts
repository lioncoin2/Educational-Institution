import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, err, failure, ok, type Clock, type Principal, type Result } from '../../../shared';
import {
  COMMUNITY_AUTHORIZATION,
  type CommunityAuthorization,
  type CommunityPermit,
} from '../../communities/contracts/authorization';
import type { CommunityAct } from '../../communities/contracts/capabilities';
import {
  COMMUNITY_MEMBERSHIP,
  type CommunityMembership,
  type MemberState,
} from '../../communities/contracts/membership';
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
 *   refused          404, identical to a missing conversation. If the caller
 *                    is still projected as a member, their row is stale: a
 *                    sync is scheduled — or, if Communities does not know
 *                    that row's change at all, a rebuild
 *   Communities down 503 — never a role-only answer
 *   permitted        the caller's row, repaired first if it is behind the
 *                    permit's stint (a join the projection has not applied
 *                    yet); still not current → 404. A row at or past the
 *                    stint is never repaired — the repair could not win — and
 *                    is checked the same way as a refused one when it is
 *                    past the stint or not current
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
    @Inject(COMMUNITY_MEMBERSHIP) private readonly membership: CommunityMembership,
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
   * a busy conversation's lock; nor does a repair that could not win.
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
    const version = row?.sourceVersion ?? 0;
    if (row !== null && version >= stint.version) {
      // At or past the stint Communities just vouched for. Past it: a change
      // committed since — or one Communities lost to a restore (§7.6); not
      // current at the stint's own version: only the latter. Ask which — the
      // answer never changes this request's, which the permit already made.
      if (version > stint.version || !isActive(row)) await this.checkRow(conversation, row);
      if (isActive(row)) return ok({ conversation, participant: row });
      // Not current, and no repair could win — the register ignores a version
      // not above the row's — so none is attempted: no conversation lock is
      // taken for a write that would change nothing.
      return err(CONVERSATION_NOT_FOUND);
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
    if (!isActive(repaired) || current === null) {
      // Still not current. A leave committed after the permit, and applied
      // first — or a newer version Communities does not know (it was restored
      // behind the projection, §7.6), which only a rebuild clears. Ask which.
      if (repaired !== null && (repaired.sourceVersion ?? 0) > stint.version) {
        await this.checkRow(conversation, repaired);
      }
      return err(CONVERSATION_NOT_FOUND);
    }
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
      // Refused, yet still projected as a current member: that row is stale.
      const row = await this.repository.findParticipant(conversation.id, principal.userId);
      if (isActive(row)) await this.checkRow(conversation, row);
      return err(CONVERSATION_NOT_FOUND);
    }
    return this.admittedToCommunityChat(principal, conversation, permit.value);
  }

  /**
   * A projected row disagrees with Communities' answer. If Communities knows
   * the row's change — the same stint at that version, or anything newer —
   * the projection is merely behind, and a sync catches it up. If it does
   * not, the projection holds a change the authority lost: a rebuild. Never
   * decides access; if Communities cannot say now, the sweeper will.
   */
  private async checkRow(conversation: Conversation, row: Participant): Promise<void> {
    const communityId = conversation.communityId;
    if (communityId === null) return;
    const answer = await askCommunities(this.logger, () =>
      this.membership.statesOf(communityId, [row.userId]),
    );
    if (!answer.ok) return;
    if (knowsRow(answer.value[0], row)) this.sync.schedule(communityId);
    else this.sync.requestReconcile(communityId);
  }
}

/** Whether the authority's latest state for this person accounts for the row's change. */
function knowsRow(state: MemberState | undefined, row: Participant): boolean {
  if (state === undefined) return false;
  const version = row.sourceVersion ?? 0;
  if (state.version !== version) return state.version > version;
  return state.membershipId === row.sourceMembershipId && state.active === isActive(row);
}

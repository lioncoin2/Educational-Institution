import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  CLOCK,
  EVENT_PUBLISHER,
  err,
  failure,
  ok,
  type AuditLog,
  type CallMetadata,
  type Clock,
  type EventPublisher,
  type Principal,
  type Result,
} from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import type { ParticipantRole } from '../contracts/vocabulary';
import type { Conversation, ConversationId } from '../domain/conversation';
import { participantAdded, participantRemoved } from '../domain/events';
import { MAX_PARTICIPANTS } from '../domain/messaging-policy';
import { canManageMembers, isActive, type Participant } from '../domain/participant';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { CONVERSATION_NOT_FOUND, ConversationAccess } from './conversation-access';
import { ConversationFactory } from './create-conversation.use-cases';
import { CONVERSATION_RESOURCE, MessagingAudit } from './messaging-settings';

const DIRECT_IS_FIXED = failure(
  'precondition_failed',
  'messaging.direct_membership_fixed',
  'A direct conversation always has exactly its two people.',
);

const NOT_OWNER = failure(
  'forbidden',
  'messaging.not_conversation_owner',
  "Only the conversation's owner may change who is in it.",
);

/** Membership changes are what the owner of a group or channel manages — never a DM's. */
function managing(conversation: Conversation, participant: Participant): Result<void> {
  if (conversation.type === 'DIRECT') return err(DIRECT_IS_FIXED);
  if (!canManageMembers(conversation.type, participant.role)) return err(NOT_OWNER);
  return ok(undefined);
}

/**
 * The owner adds people. Four checks, all required:
 *
 *   permission  `messaging.read` to reach the conversation, AND the right to
 *               create this kind (`create_group` / `create_channel`) — managing
 *               a group's audience is part of running one;
 *   membership  the caller is a current member…
 *   resource    …and its OWNER; the conversation is not a DM;
 *   eligibility each newcomer is an ACTIVE account with messaging access.
 *
 * Holding `messaging.manage` does NOT let anyone add people — least of all
 * themselves. Moderation removes; it never grants access to a conversation.
 */
@Injectable()
export class AddParticipantsUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly factory: ConversationFactory,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly conversationId: string;
    readonly userIds: readonly string[];
    readonly role?: ParticipantRole;
    readonly meta: CallMetadata;
  }): Promise<Result<{ added: string[]; unchanged: string[] }>> {
    const { principal } = command;
    const membership = await this.access.member(
      principal,
      command.conversationId,
      Permissions.messaging.read,
    );
    if (!membership.ok) return membership;
    const { conversation, participant } = membership.value;
    const managed = managing(conversation, participant);
    if (!managed.ok) return managed;

    const creates =
      conversation.type === 'CHANNEL'
        ? Permissions.messaging.createChannel
        : Permissions.messaging.createGroup;
    const mayManage = this.access.authorize(principal, creates, conversation.id);
    if (!mayManage.ok) return mayManage;

    const role = command.role ?? 'MEMBER';
    if (role === 'OWNER' || (role === 'PUBLISHER' && conversation.type !== 'CHANNEL')) {
      return err(
        failure(
          'validation',
          'messaging.role_not_assignable',
          conversation.type === 'CHANNEL'
            ? 'People are added as MEMBER or PUBLISHER.'
            : 'People are added to a group as MEMBER.',
        ),
      );
    }

    const userIds = [...new Set(command.userIds)];
    if (userIds.length === 0) {
      return err(failure('validation', 'messaging.participants_required', 'Name someone to add.'));
    }
    const eligible = await this.factory.eligible(
      userIds,
      role === 'PUBLISHER' ? Permissions.messaging.send : Permissions.messaging.read,
    );
    if (!eligible.ok) return eligible;

    const outcome = await this.repository.addParticipants({
      conversationId: conversation.id,
      userIds,
      role,
      addedBy: principal.userId,
      at: this.clock.now(),
      capacity: MAX_PARTICIPANTS[conversation.type],
    });
    switch (outcome.kind) {
      case 'conversation_not_found':
        return err(CONVERSATION_NOT_FOUND);
      case 'capacity_exceeded':
        return err(
          failure(
            'precondition_failed',
            'messaging.too_many_participants',
            `This ${conversation.type.toLowerCase()} may have at most ${outcome.capacity} members.`,
            { maxParticipants: outcome.capacity, memberCount: outcome.memberCount },
          ),
        );
      case 'added':
        break;
    }

    for (const added of outcome.added) {
      await this.audit.record({
        actorUserId: principal.userId,
        action: MessagingAudit.participantAdded,
        resourceType: CONVERSATION_RESOURCE,
        resourceId: conversation.id,
        at: added.joinedAt,
        metadata: { userId: added.userId, role: added.role },
        correlationId: command.meta.correlationId,
      });
    }
    await this.events.publish(
      outcome.added.map((added) =>
        participantAdded(added, principal.userId, command.meta.correlationId),
      ),
    );
    return ok({
      added: outcome.added.map((added) => added.userId),
      unchanged: [...outcome.unchanged],
    });
  }
}

/**
 * Taking someone out of a group or channel. Two routes to it:
 *
 *   the OWNER, as a current member, removes anyone but themselves;
 *   a holder of `messaging.manage` — moderation — removes anyone but the
 *   owner, without being a member, and it is audited as moderation.
 *
 * Neither can empty a DM, and neither removes the owner (ownership transfer
 * is future work). Moderation removes access; it never reads or grants it.
 */
@Injectable()
export class RemoveParticipantUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly conversationId: string;
    readonly userId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<void>> {
    const { principal } = command;
    const id = command.conversationId as ConversationId;

    const route = await this.route(principal, id);
    if (!route.ok) return route;
    const { conversation, moderated } = route.value;
    if (conversation.type === 'DIRECT') return err(DIRECT_IS_FIXED);

    if (command.userId === principal.userId && !moderated) {
      return err(
        failure('validation', 'messaging.use_leave', 'To leave a conversation yourself, leave it.'),
      );
    }
    const target = await this.repository.findParticipant(id, command.userId);
    if (!isActive(target)) {
      return err(
        failure('not_found', 'messaging.participant_not_found', 'That person is not a member.'),
      );
    }
    if (target.role === 'OWNER') {
      return err(
        failure(
          'precondition_failed',
          'messaging.owner_not_removable',
          'The owner of a conversation cannot be removed.',
        ),
      );
    }

    const now = this.clock.now();
    const removed = await this.repository.removeParticipant(id, command.userId, now);
    if (removed === null) {
      return err(
        failure('not_found', 'messaging.participant_not_found', 'That person is not a member.'),
      );
    }

    await this.audit.record({
      actorUserId: principal.userId,
      action: moderated
        ? MessagingAudit.moderationParticipantRemoved
        : MessagingAudit.participantRemoved,
      resourceType: CONVERSATION_RESOURCE,
      resourceId: id,
      at: now,
      metadata: { userId: command.userId, role: removed.role },
      correlationId: command.meta.correlationId,
    });
    await this.events.publish([
      participantRemoved(
        removed,
        principal.userId,
        moderated ? 'moderated' : 'removed',
        now,
        command.meta.correlationId,
      ),
    ]);
    return ok(undefined);
  }

  /** As the owner if they are one; otherwise as a moderator if they may; otherwise not at all. */
  private async route(
    principal: Principal,
    id: ConversationId,
  ): Promise<Result<{ conversation: Conversation; moderated: boolean }>> {
    const membership = await this.access.member(principal, id, Permissions.messaging.read);
    if (membership.ok && membership.value.participant.role === 'OWNER') {
      return ok({ conversation: membership.value.conversation, moderated: false });
    }
    if (this.access.can(principal, Permissions.messaging.manage)) {
      const conversation = await this.repository.findConversation(id);
      return conversation === null
        ? err(CONVERSATION_NOT_FOUND)
        : ok({ conversation, moderated: true });
    }
    if (!membership.ok) return membership;
    return membership.value.conversation.type === 'DIRECT' ? err(DIRECT_IS_FIXED) : err(NOT_OWNER);
  }
}

/** Leaving a group or channel. A DM cannot be left; its owner cannot leave a group (yet). */
@Injectable()
export class LeaveConversationUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly conversationId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<void>> {
    const { principal } = command;
    const membership = await this.access.member(
      principal,
      command.conversationId,
      Permissions.messaging.read,
    );
    if (!membership.ok) return membership;
    const { conversation, participant } = membership.value;
    if (conversation.type === 'DIRECT') return err(DIRECT_IS_FIXED);
    if (participant.role === 'OWNER') {
      return err(
        failure(
          'precondition_failed',
          'messaging.owner_cannot_leave',
          'The owner cannot leave; ownership transfer is not available yet.',
        ),
      );
    }

    const now = this.clock.now();
    const left = await this.repository.removeParticipant(conversation.id, principal.userId, now);
    if (left === null) return err(CONVERSATION_NOT_FOUND);

    await this.audit.record({
      actorUserId: principal.userId,
      action: MessagingAudit.participantLeft,
      resourceType: CONVERSATION_RESOURCE,
      resourceId: conversation.id,
      at: now,
      correlationId: command.meta.correlationId,
    });
    await this.events.publish([
      participantRemoved(left, principal.userId, 'left', now, command.meta.correlationId),
    ]);
    return ok(undefined);
  }
}

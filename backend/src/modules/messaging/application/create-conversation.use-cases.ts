import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  CLOCK,
  EVENT_PUBLISHER,
  ID_GENERATOR,
  RATE_LIMITER,
  err,
  failure,
  ok,
  type AuditLog,
  type CallMetadata,
  type Clock,
  type EventPublisher,
  type IdGenerator,
  type Principal,
  type RateLimiter,
  type Result,
} from '../../../shared';
import {
  ACCOUNT_DIRECTORY,
  type AccountDirectory,
} from '../../identity/contracts/account-directory';
import { Permissions, type Permission } from '../../identity/contracts/permissions';
import {
  newChannelConversation,
  newDirectConversation,
  newGroupConversation,
  type NewConversation,
} from '../domain/conversation';
import { conversationCreated } from '../domain/events';
import { MAX_PARTICIPANTS_PER_REQUEST } from '../domain/messaging-policy';
import {
  MESSAGING_READ_MODEL,
  MESSAGING_REPOSITORY,
  type MessagingReadModel,
  type MessagingRepository,
} from '../domain/ports';
import { ConversationAccess } from './conversation-access';
import {
  CONVERSATIONS_CREATED_PER_USER,
  CONVERSATION_RESOURCE,
  MessagingAudit,
} from './messaging-settings';
import { MessagingViews } from './messaging-views';
import type { ConversationView } from './views';

export interface CreatedConversation {
  readonly conversation: ConversationView;
  /** False when a direct conversation with this person already existed. */
  readonly created: boolean;
}

/**
 * The shared steps of starting any conversation: who may, how often, who may
 * be in it, and what is recorded once it exists.
 */
@Injectable()
export class ConversationFactory {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    private readonly views: MessagingViews,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  /**
   * The creating permission, plus `messaging.read`: a conversation its own
   * creator could not open would be a strange thing to allow.
   */
  async admit(principal: Principal, permission: Permission): Promise<Result<void>> {
    const allowed = this.access.authorize(principal, permission);
    if (!allowed.ok) return allowed;
    const reads = this.access.authorize(principal, Permissions.messaging.read);
    if (!reads.ok) return reads;

    const throttle = await this.limiter.consume(principal.userId, CONVERSATIONS_CREATED_PER_USER);
    if (!throttle.allowed) {
      return err(
        failure(
          'rate_limited',
          'messaging.too_many_conversations',
          'Too many new conversations. Try again later.',
          { retryAfterSeconds: throttle.retryAfterSeconds },
        ),
      );
    }
    return ok(undefined);
  }

  /**
   * Everyone named must be an ACTIVE account holding `permission` — decided by
   * identity, the same way as for a signed-in user. An unknown id and an
   * ineligible one are reported alike: no probing for accounts.
   */
  async eligible(userIds: readonly string[], permission: Permission): Promise<Result<void>> {
    if (userIds.length === 0) return ok(undefined);
    if (userIds.length > MAX_PARTICIPANTS_PER_REQUEST) {
      return err(
        failure(
          'validation',
          'messaging.too_many_in_request',
          `Add at most ${MAX_PARTICIPANTS_PER_REQUEST} people at a time.`,
          { maxPerRequest: MAX_PARTICIPANTS_PER_REQUEST },
        ),
      );
    }
    const allowed = await this.directory.withPermission(userIds, permission);
    const refused = userIds.filter((userId) => !allowed.has(userId));
    if (refused.length > 0) {
      return err(
        failure(
          'validation',
          'messaging.participant_not_eligible',
          'Some of these people cannot take part in conversations.',
          { userIds: refused },
        ),
      );
    }
    return ok(undefined);
  }

  /** After the conversation is stored: the audit entry, the event, the creator's view. */
  async created(
    principal: Principal,
    input: NewConversation,
    meta: CallMetadata,
  ): Promise<Result<ConversationView>> {
    const { conversation } = input;
    await this.audit.record({
      actorUserId: principal.userId,
      action: MessagingAudit.conversationCreated,
      resourceType: CONVERSATION_RESOURCE,
      resourceId: conversation.id,
      at: conversation.createdAt,
      metadata: { type: conversation.type, participantCount: conversation.memberCount },
      correlationId: meta.correlationId,
    });
    await this.events.publish([conversationCreated(conversation, meta.correlationId)]);
    return this.viewFor(principal, conversation.id);
  }

  async viewFor(principal: Principal, conversationId: string): Promise<Result<ConversationView>> {
    const row = await this.readModel.conversationSummary(
      conversationId as NewConversation['conversation']['id'],
      principal.userId,
    );
    if (row === null) {
      return err(failure('not_found', 'messaging.conversation_not_found', 'No such conversation.'));
    }
    const [view] = await this.views.conversations([row]);
    return view === undefined
      ? err(failure('not_found', 'messaging.conversation_not_found', 'No such conversation.'))
      : ok(view);
  }
}

/**
 * Start — or return — the direct conversation with one person.
 *
 * At most one exists per pair, decided by the database: asking twice, or two
 * people asking at the same instant, yields the same conversation.
 */
@Injectable()
export class StartDirectConversationUseCase {
  constructor(
    private readonly factory: ConversationFactory,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly counterpartUserId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<CreatedConversation>> {
    const { principal } = command;
    const admitted = await this.factory.admit(principal, Permissions.messaging.startDirect);
    if (!admitted.ok) return admitted;

    const draft = newDirectConversation({
      id: this.ids.next<'Conversation'>(),
      initiator: principal.userId,
      counterpart: command.counterpartUserId,
      at: this.clock.now(),
    });
    if (!draft.ok) return draft;

    const eligible = await this.factory.eligible(
      [command.counterpartUserId],
      Permissions.messaging.read,
    );
    if (!eligible.ok) return eligible;

    const outcome = await this.repository.createDirectConversation(draft.value);
    if (!outcome.created) {
      const existing = await this.factory.viewFor(principal, outcome.conversation.id);
      return existing.ok ? ok({ conversation: existing.value, created: false }) : existing;
    }
    const view = await this.factory.created(principal, draft.value, command.meta);
    return view.ok ? ok({ conversation: view.value, created: true }) : view;
  }
}

/** A group: its creator owns it; every member may write. */
@Injectable()
export class CreateGroupUseCase {
  constructor(
    private readonly factory: ConversationFactory,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly title: string;
    readonly memberIds: readonly string[];
    readonly meta: CallMetadata;
  }): Promise<Result<ConversationView>> {
    const { principal } = command;
    const admitted = await this.factory.admit(principal, Permissions.messaging.createGroup);
    if (!admitted.ok) return admitted;

    const memberIds = others(command.memberIds, principal.userId);
    const draft = newGroupConversation({
      id: this.ids.next<'Conversation'>(),
      creator: principal.userId,
      title: command.title,
      memberIds,
      at: this.clock.now(),
    });
    if (!draft.ok) return draft;

    const eligible = await this.factory.eligible(memberIds, Permissions.messaging.read);
    if (!eligible.ok) return eligible;

    await this.repository.createConversation(draft.value);
    return this.factory.created(principal, draft.value, command.meta);
  }
}

/**
 * A channel: many read, few write. Publishers must hold `messaging.send`
 * (they could not post otherwise); readers need `messaging.read`.
 */
@Injectable()
export class CreateChannelUseCase {
  constructor(
    private readonly factory: ConversationFactory,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly title: string;
    readonly memberIds: readonly string[];
    readonly publisherIds: readonly string[];
    readonly meta: CallMetadata;
  }): Promise<Result<ConversationView>> {
    const { principal } = command;
    const admitted = await this.factory.admit(principal, Permissions.messaging.createChannel);
    if (!admitted.ok) return admitted;

    const publisherIds = others(command.publisherIds, principal.userId);
    const memberIds = others(command.memberIds, principal.userId).filter(
      (userId) => !publisherIds.includes(userId),
    );
    const draft = newChannelConversation({
      id: this.ids.next<'Conversation'>(),
      creator: principal.userId,
      title: command.title,
      memberIds,
      publisherIds,
      at: this.clock.now(),
    });
    if (!draft.ok) return draft;

    const readers = await this.factory.eligible(memberIds, Permissions.messaging.read);
    if (!readers.ok) return readers;
    const publishers = await this.factory.eligible(publisherIds, Permissions.messaging.send);
    if (!publishers.ok) return publishers;

    await this.repository.createConversation(draft.value);
    return this.factory.created(principal, draft.value, command.meta);
  }
}

/** Distinct ids, without the creator — who is always in, as owner. */
function others(userIds: readonly string[], self: string): string[] {
  return [...new Set(userIds)].filter((userId) => userId !== self);
}

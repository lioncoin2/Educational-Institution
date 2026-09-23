import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { InMemoryRateLimiter } from '../../src/platform/rate-limit/in-memory-rate-limiter';
import type { Principal } from '../../src/shared';
import type {
  AccountDirectory,
  AccountSummary,
} from '../../src/modules/identity/contracts/account-directory';
import type { Permission } from '../../src/modules/identity/contracts/permissions';
import { PolicyAuthorizationService } from '../../src/modules/identity/application/authorization.service';
import { PROVISIONAL_POLICY_RULES } from '../../src/modules/identity/domain/provisional-policy';
import type { KnownRoleCode } from '../../src/modules/identity/domain/role';
import { GetAttachmentLinkUseCase } from '../../src/modules/messaging/application/attachment-link.use-case';
import { ConversationAccess } from '../../src/modules/messaging/application/conversation-access';
import {
  ConversationFactory,
  CreateChannelUseCase,
  CreateGroupUseCase,
  StartDirectConversationUseCase,
} from '../../src/modules/messaging/application/create-conversation.use-cases';
import { MarkReadUseCase } from '../../src/modules/messaging/application/mark-read.use-case';
import {
  AddParticipantsUseCase,
  LeaveConversationUseCase,
  RemoveParticipantUseCase,
} from '../../src/modules/messaging/application/membership.use-cases';
import { MessageRecipientsService } from '../../src/modules/messaging/application/message-recipients.service';
import { SENDS_PER_USER } from '../../src/modules/messaging/application/messaging-settings';
import { MessagingViews } from '../../src/modules/messaging/application/messaging-views';
import {
  GetConversationUseCase,
  ListConversationsUseCase,
  ListMessagesUseCase,
  ListParticipantsUseCase,
} from '../../src/modules/messaging/application/read-conversations.use-cases';
import {
  MessageSender,
  SendFileMessageUseCase,
  SendImageMessageUseCase,
  SendTextMessageUseCase,
  SendVoiceMessageUseCase,
  type SentMessage,
} from '../../src/modules/messaging/application/send-message.use-cases';
import type { ConversationView } from '../../src/modules/messaging/application/views';
import type {
  MessagingReadModel,
  MessagingRepository,
} from '../../src/modules/messaging/domain/ports';
import { InMemoryMessagingStore } from '../../src/modules/messaging/infrastructure/in-memory-messaging-store';
import { filesHarness } from './files-harness';
import { AdjustableClock, RecordingAuditLog, RecordingEvents, expectOk } from './identity-harness';
import { principalWith } from './principals';

export const META = { correlationId: 'test-request' } as const;

/**
 * Identity's account directory, as far as messaging can tell: accounts with
 * roles and a status, and eligibility decided by the REAL authorization
 * service over the provisional matrix — the same decision identity makes.
 */
export class FakeAccountDirectory implements AccountDirectory {
  private readonly accounts = new Map<
    string,
    { displayName: string; active: boolean; roles: readonly KnownRoleCode[] }
  >();

  constructor(
    private readonly authorization = new PolicyAuthorizationService(PROVISIONAL_POLICY_RULES),
  ) {}

  add(
    userId: string,
    roles: readonly KnownRoleCode[],
    options: { displayName?: string; active?: boolean } = {},
  ): void {
    this.accounts.set(userId, {
      displayName: options.displayName ?? userId,
      active: options.active ?? true,
      roles,
    });
  }

  deactivate(userId: string): void {
    const account = this.accounts.get(userId);
    if (account !== undefined) this.accounts.set(userId, { ...account, active: false });
  }

  async describe(userIds: readonly string[]): Promise<readonly AccountSummary[]> {
    return [...new Set(userIds)].flatMap((userId) => {
      const account = this.accounts.get(userId);
      return account === undefined
        ? []
        : [{ userId, displayName: account.displayName, active: account.active }];
    });
  }

  async withPermission(
    userIds: readonly string[],
    permission: Permission,
  ): Promise<ReadonlySet<string>> {
    return new Set(
      userIds.filter((userId) => {
        const account = this.accounts.get(userId);
        return (
          account !== undefined &&
          account.active &&
          this.authorization.can(principalWith(userId, account.roles), permission)
        );
      }),
    );
  }
}

/**
 * The messaging application layer, wired by hand: every use case, over the
 * in-memory store by default (or any adapters passed in — the Postgres suite
 * runs the same scenarios over Drizzle), with the real files stack in a temp
 * directory for attachments.
 */
export async function messagingHarness(
  options: {
    readonly repository?: MessagingRepository;
    readonly readModel?: MessagingReadModel;
  } = {},
) {
  const clock = new AdjustableClock();
  const files = await filesHarness({ clock });
  const memory = new InMemoryMessagingStore();
  const repository = options.repository ?? memory;
  const readModel = options.readModel ?? memory;
  const ids = new UuidIdGenerator();
  const authorization = new PolicyAuthorizationService(PROVISIONAL_POLICY_RULES);
  const directory = new FakeAccountDirectory(authorization);
  const limiter = new InMemoryRateLimiter(clock);
  const audit = new RecordingAuditLog();
  const events = new RecordingEvents();

  const access = new ConversationAccess(authorization, repository);
  const views = new MessagingViews(directory, files.fileAssets);
  const factory = new ConversationFactory(
    access,
    directory,
    readModel,
    views,
    limiter,
    audit,
    events,
  );
  const sender = new MessageSender(
    access,
    repository,
    files.fileAssets,
    views,
    limiter,
    events,
    clock,
    ids,
  );

  let people = 0;
  const h = {
    clock,
    files,
    repository,
    readModel,
    directory,
    limiter,
    audit,
    events,
    authorization,

    startDirect: new StartDirectConversationUseCase(factory, repository, clock, ids),
    createGroup: new CreateGroupUseCase(factory, repository, clock, ids),
    createChannel: new CreateChannelUseCase(factory, repository, clock, ids),
    sendText: new SendTextMessageUseCase(sender),
    sendVoice: new SendVoiceMessageUseCase(sender),
    sendImage: new SendImageMessageUseCase(sender),
    sendFile: new SendFileMessageUseCase(sender),
    listConversations: new ListConversationsUseCase(access, readModel, views),
    getConversation: new GetConversationUseCase(access, readModel, views),
    listMessages: new ListMessagesUseCase(access, readModel, views),
    listParticipants: new ListParticipantsUseCase(access, readModel, views),
    markRead: new MarkReadUseCase(access, repository, events, clock),
    addParticipants: new AddParticipantsUseCase(access, factory, repository, audit, events, clock),
    removeParticipant: new RemoveParticipantUseCase(access, repository, audit, events, clock),
    leave: new LeaveConversationUseCase(access, repository, audit, events, clock),
    attachmentLink: new GetAttachmentLinkUseCase(access, repository, files.fileAssets),
    recipients: new MessageRecipientsService(readModel),

    /** A new ACTIVE account with these roles, and the principal it signs in as. */
    person(role: KnownRoleCode, displayName?: string, extraRoles: KnownRoleCode[] = []): Principal {
      people += 1;
      const userId = `${role.toLowerCase()}-${people}-${ids.next<'User'>()}`.slice(0, 64);
      const roles = [role, ...extraRoles];
      directory.add(userId, roles, { displayName: displayName ?? `${role} ${people}` });
      return principalWith(userId, roles);
    },

    async group(
      owner: Principal,
      members: readonly Principal[],
      title = 'حلقة الفجر',
    ): Promise<ConversationView> {
      return expectOk(
        await h.createGroup.execute({
          principal: owner,
          title,
          memberIds: members.map((member) => member.userId),
          meta: META,
        }),
      );
    },

    async direct(initiator: Principal, counterpart: Principal): Promise<ConversationView> {
      return expectOk(
        await h.startDirect.execute({
          principal: initiator,
          counterpartUserId: counterpart.userId,
          meta: META,
        }),
      ).conversation;
    },

    async text(
      principal: Principal,
      conversationId: string,
      body: string,
      clientMessageId: string = ids.next<'Client'>(),
    ): Promise<SentMessage> {
      return expectOk(
        await h.sendText.execute({ principal, conversationId, clientMessageId, body, meta: META }),
      );
    },

    /** Sends `count` messages, moving the clock past the send limit as needed. */
    async burst(principal: Principal, conversationId: string, count: number): Promise<void> {
      for (let i = 1; i <= count; i++) {
        if (i % SENDS_PER_USER.limit === 0) clock.advance(SENDS_PER_USER.windowSeconds);
        await h.text(principal, conversationId, `message ${i}`);
      }
    },

    async cleanup(): Promise<void> {
      await files.cleanup();
    },
  };
  return h;
}

export type MessagingHarness = Awaited<ReturnType<typeof messagingHarness>>;

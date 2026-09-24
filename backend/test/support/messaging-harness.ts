import { InProcessEventBus } from '../../src/platform/events/event-bus';
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
import { CommunityChatReconciler } from '../../src/modules/messaging/application/community-chat-reconciler';
import {
  DEFAULT_COMMUNITY_CHAT_SETTINGS,
  type CommunityChatSettings,
} from '../../src/modules/messaging/application/community-chat-settings';
import { CommunityChatSweeper } from '../../src/modules/messaging/application/community-chat-sweeper';
import { CommunityChatSync } from '../../src/modules/messaging/application/community-chat-sync';
import { GetCommunityChatUseCase } from '../../src/modules/messaging/application/community-chat.use-case';
import { CommunityChats } from '../../src/modules/messaging/application/community-chats';
import { ConversationAccess } from '../../src/modules/messaging/application/conversation-access';
import {
  ConversationFactory,
  CreateChannelUseCase,
  CreateGroupUseCase,
  StartDirectConversationUseCase,
} from '../../src/modules/messaging/application/create-conversation.use-cases';
import { MarkReadUseCase } from '../../src/modules/messaging/application/mark-read.use-case';
import { MessageDeliveryService } from '../../src/modules/messaging/application/message-delivery.service';
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
import { communitiesHarness, type CommunitiesHarness } from './communities-harness';
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
    {
      displayName: string;
      active: boolean;
      roles: readonly KnownRoleCode[];
      /** Replaces what the roles grant — for combinations no provisional role has. */
      permissions?: readonly Permission[];
    }
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

  /** Exactly these permissions from now on, whatever the account's roles say. */
  setPermissions(userId: string, permissions: readonly Permission[]): void {
    const account = this.accounts.get(userId);
    if (account !== undefined) this.accounts.set(userId, { ...account, permissions });
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
        if (account === undefined || !account.active) return false;
        if (account.permissions !== undefined) return account.permissions.includes(permission);
        return this.authorization.can(principalWith(userId, account.roles), permission);
      }),
    );
  }
}

/**
 * The messaging application layer, wired by hand: every use case, over the
 * in-memory store by default (or any adapters passed in — the Postgres suite
 * runs the same scenarios over Drizzle), with the real files stack in a temp
 * directory for attachments.
 *
 * Communities is wired in exactly as the module does it: its real
 * authorization service and contracts, over its in-memory store unless a
 * harness is passed in. Communities' events reach messaging through a real
 * in-process bus only when a test hands them over (`deliverCommunityEvents`),
 * so a test decides when — or whether — a wake-up arrives.
 */
export async function messagingHarness(
  options: {
    readonly repository?: MessagingRepository;
    readonly readModel?: MessagingReadModel;
    readonly communities?: CommunitiesHarness;
    readonly settings?: Partial<CommunityChatSettings>;
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

  const communities = options.communities ?? communitiesHarness({ identity: authorization });
  const bus = new InProcessEventBus();
  const settings: CommunityChatSettings = {
    ...DEFAULT_COMMUNITY_CHAT_SETTINGS,
    sweepIntervalMs: 0,
    ...options.settings,
  };
  const sync = new CommunityChatSync(
    bus,
    communities.membership,
    repository,
    readModel,
    clock,
    ids,
  );
  sync.onModuleInit();
  const reconciler = new CommunityChatReconciler(
    communities.membership,
    repository,
    readModel,
    sync,
    clock,
  );
  const sweeper = new CommunityChatSweeper(
    communities.membership,
    readModel,
    sync,
    reconciler,
    settings,
  );

  const access = new ConversationAccess(
    authorization,
    repository,
    communities.authorization,
    sync,
    clock,
  );
  const communityChats = new CommunityChats(
    communities.authorization,
    communities.directory,
    settings,
    access,
    sync,
  );
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
    communityChats,
  );

  const getConversation = new GetConversationUseCase(access, readModel, views, communityChats);

  let people = 0;
  let deliveredCommunityEvents = 0;
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
    communities,
    bus,
    settings,
    sync,
    reconciler,
    sweeper,
    access,

    startDirect: new StartDirectConversationUseCase(factory, repository, clock, ids),
    createGroup: new CreateGroupUseCase(factory, repository, clock, ids),
    createChannel: new CreateChannelUseCase(factory, repository, clock, ids),
    sendText: new SendTextMessageUseCase(sender),
    sendVoice: new SendVoiceMessageUseCase(sender),
    sendImage: new SendImageMessageUseCase(sender),
    sendFile: new SendFileMessageUseCase(sender),
    listConversations: new ListConversationsUseCase(access, readModel, views, communityChats),
    getConversation,
    listMessages: new ListMessagesUseCase(access, readModel, views),
    listParticipants: new ListParticipantsUseCase(access, readModel, views),
    markRead: new MarkReadUseCase(access, repository, events, clock),
    addParticipants: new AddParticipantsUseCase(access, factory, repository, audit, events, clock),
    removeParticipant: new RemoveParticipantUseCase(access, repository, audit, events, clock),
    leave: new LeaveConversationUseCase(access, repository, audit, events, clock),
    attachmentLink: new GetAttachmentLinkUseCase(access, repository, files.fileAssets),
    recipients: new MessageRecipientsService(
      readModel,
      directory,
      repository,
      communities.membership,
      sync,
    ),
    delivery: new MessageDeliveryService(repository, views, getConversation),
    communityChat: new GetCommunityChatUseCase(
      access,
      repository,
      readModel,
      getConversation,
      sync,
      limiter,
      clock,
      ids,
    ),

    /**
     * A new ACTIVE account with these roles, and the principal it signs in as —
     * known to messaging's directory and to Communities' alike.
     */
    person(role: KnownRoleCode, displayName?: string, extraRoles: KnownRoleCode[] = []): Principal {
      people += 1;
      const userId = `${role.toLowerCase()}-${people}-${ids.next<'User'>()}`.slice(0, 64);
      const roles = [role, ...extraRoles];
      directory.add(userId, roles, { displayName: displayName ?? `${role} ${people}` });
      communities.accounts.add(userId, roles, displayName ?? `${role} ${people}`);
      return principalWith(userId, roles);
    },

    /**
     * Hands Communities' events published since the last call to messaging's
     * subscribers, as the in-process bus would, and waits for the syncs they
     * scheduled. A test that never calls it is a test of lost wake-ups.
     */
    async deliverCommunityEvents(): Promise<void> {
      const pending = communities.journal.events.slice(deliveredCommunityEvents);
      deliveredCommunityEvents = communities.journal.events.length;
      await bus.publish(pending);
      await sync.idle();
    },

    /** A community owned by `owner`, with these members, through Communities' use cases. */
    async community(owner: Principal, members: readonly Principal[] = []): Promise<string> {
      const communityId = await communities.community(owner);
      if (members.length > 0) {
        await communities.addPeople(owner, communityId, ...members.map((member) => member.userId));
      }
      return communityId;
    },

    /** The community's chat, opened by `principal` through the route's use case. */
    async openCommunityChat(principal: Principal, communityId: string): Promise<ConversationView> {
      return expectOk(await h.communityChat.execute({ principal, communityId }));
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
      await sync.onModuleDestroy();
      await files.cleanup();
    },
  };
  return h;
}

export type MessagingHarness = Awaited<ReturnType<typeof messagingHarness>>;

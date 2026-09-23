import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { DATABASE, type Database } from '../../platform/database';
import { FilesModule } from '../files/files.module';
import { IdentityModule } from '../identity/identity.module';
import { ConversationsController } from './api/conversations.controller';
import { GetAttachmentLinkUseCase } from './application/attachment-link.use-case';
import { ConversationAccess } from './application/conversation-access';
import {
  ConversationFactory,
  CreateChannelUseCase,
  CreateGroupUseCase,
  StartDirectConversationUseCase,
} from './application/create-conversation.use-cases';
import { MarkReadUseCase } from './application/mark-read.use-case';
import {
  AddParticipantsUseCase,
  LeaveConversationUseCase,
  RemoveParticipantUseCase,
} from './application/membership.use-cases';
import { MessageRecipientsService } from './application/message-recipients.service';
import { MessagingViews } from './application/messaging-views';
import {
  GetConversationUseCase,
  ListConversationsUseCase,
  ListMessagesUseCase,
  ListParticipantsUseCase,
} from './application/read-conversations.use-cases';
import {
  MessageSender,
  SendFileMessageUseCase,
  SendImageMessageUseCase,
  SendTextMessageUseCase,
  SendVoiceMessageUseCase,
} from './application/send-message.use-cases';
import { MESSAGE_RECIPIENTS } from './contracts/message-recipients';
import {
  MESSAGING_READ_MODEL,
  MESSAGING_REPOSITORY,
  type MessagingReadModel,
  type MessagingRepository,
} from './domain/ports';
import { DrizzleMessagingReadModel } from './infrastructure/drizzle-messaging-read-model';
import { DrizzleMessagingRepository } from './infrastructure/drizzle-messaging-repository';
import { InMemoryMessagingStore } from './infrastructure/in-memory-messaging-store';

/**
 * Messaging — conversations, membership, messages, ordering and read state.
 *
 * It depends on identity's contracts (may this principal…? who is this
 * account?) and files' contract (is this upload attachable? a link to it,
 * please), and on nothing else. It never imports a push provider or a
 * realtime transport: it publishes `messaging.*` events, and delivery
 * modules subscribe. It exports one thing — `MESSAGE_RECIPIENTS`, current
 * membership for those delivery modules.
 */
@Module({
  imports: [IdentityModule, FilesModule],
  controllers: [ConversationsController],
  providers: [
    // Without a database, one in-memory store serves both ports, so what is
    // written is what is read.
    InMemoryMessagingStore,
    {
      provide: MESSAGING_REPOSITORY,
      inject: [APP_CONFIG, DATABASE, InMemoryMessagingStore],
      useFactory: (config: AppConfig, db: Database, memory: InMemoryMessagingStore) =>
        (config.database.configured
          ? new DrizzleMessagingRepository(db)
          : memory) satisfies MessagingRepository,
    },
    {
      provide: MESSAGING_READ_MODEL,
      inject: [APP_CONFIG, DATABASE, InMemoryMessagingStore],
      useFactory: (config: AppConfig, db: Database, memory: InMemoryMessagingStore) =>
        (config.database.configured
          ? new DrizzleMessagingReadModel(db)
          : memory) satisfies MessagingReadModel,
    },

    ConversationAccess,
    MessagingViews,
    ConversationFactory,
    MessageSender,
    StartDirectConversationUseCase,
    CreateGroupUseCase,
    CreateChannelUseCase,
    SendTextMessageUseCase,
    SendVoiceMessageUseCase,
    SendImageMessageUseCase,
    SendFileMessageUseCase,
    ListConversationsUseCase,
    GetConversationUseCase,
    ListMessagesUseCase,
    ListParticipantsUseCase,
    MarkReadUseCase,
    AddParticipantsUseCase,
    RemoveParticipantUseCase,
    LeaveConversationUseCase,
    GetAttachmentLinkUseCase,
    { provide: MESSAGE_RECIPIENTS, useClass: MessageRecipientsService },
  ],
  exports: [MESSAGE_RECIPIENTS],
})
export class MessagingModule {}

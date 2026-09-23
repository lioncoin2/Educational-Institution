import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { RequestMetadata } from '../../../platform/http/call-metadata.decorator';
import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import type { CallMetadata, Principal, Result } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { Authenticated, RequirePermission } from '../../identity/contracts/route-access';
import { GetAttachmentLinkUseCase } from '../application/attachment-link.use-case';
import {
  CreateChannelUseCase,
  CreateGroupUseCase,
  StartDirectConversationUseCase,
} from '../application/create-conversation.use-cases';
import { MarkReadUseCase } from '../application/mark-read.use-case';
import {
  AddParticipantsUseCase,
  LeaveConversationUseCase,
  RemoveParticipantUseCase,
} from '../application/membership.use-cases';
import {
  GetConversationUseCase,
  ListConversationsUseCase,
  ListMessagesUseCase,
  ListParticipantsUseCase,
} from '../application/read-conversations.use-cases';
import {
  SendFileMessageUseCase,
  SendImageMessageUseCase,
  SendTextMessageUseCase,
  SendVoiceMessageUseCase,
  type SentMessage,
} from '../application/send-message.use-cases';
import {
  AddParticipantsDto,
  CreateChannelDto,
  CreateGroupDto,
  ListConversationsQuery,
  ListMessagesQuery,
  ListParticipantsQuery,
  MarkReadDto,
  SendMediaDto,
  SendTextDto,
  StartDirectDto,
} from './dto/messaging.dto';
import {
  toConversationResponse,
  toLinkResponse,
  toMessagePageResponse,
  toMessageResponse,
  toParticipantResponse,
  type ConversationResponse,
  type MessagePageResponse,
  type MessageResponse,
  type ParticipantResponse,
} from './responses';

/**
 * Conversations and their messages.
 *
 * The permission on each route is the coarse gate. Every use case re-checks
 * it with the conversation in context, then checks membership and the
 * conversation's own rules — so `messaging.read` on a route means "may read
 * the conversations you are in", never more.
 *
 * Sends answer 201 when a message was stored and 200 when the request was a
 * retry of one already stored (same clientMessageId, same content).
 */
@Controller('messaging/conversations')
export class ConversationsController {
  constructor(
    private readonly listConversations: ListConversationsUseCase,
    private readonly getConversation: GetConversationUseCase,
    private readonly listMessages: ListMessagesUseCase,
    private readonly listParticipants: ListParticipantsUseCase,
    private readonly startDirect: StartDirectConversationUseCase,
    private readonly createGroup: CreateGroupUseCase,
    private readonly createChannel: CreateChannelUseCase,
    private readonly sendText: SendTextMessageUseCase,
    private readonly sendVoice: SendVoiceMessageUseCase,
    private readonly sendImage: SendImageMessageUseCase,
    private readonly sendFile: SendFileMessageUseCase,
    private readonly markRead: MarkReadUseCase,
    private readonly addParticipants: AddParticipantsUseCase,
    private readonly removeParticipant: RemoveParticipantUseCase,
    private readonly leaveConversation: LeaveConversationUseCase,
    private readonly attachmentLink: GetAttachmentLinkUseCase,
  ) {}

  @Get()
  @RequirePermission(Permissions.messaging.read)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListConversationsQuery,
  ): Promise<{ items: ConversationResponse[]; nextCursor: string | null }> {
    const page = unwrap(
      await this.listConversations.execute({
        principal,
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
    return { items: page.items.map(toConversationResponse), nextCursor: page.nextCursor };
  }

  @Post('direct')
  @RequirePermission(Permissions.messaging.startDirect)
  async direct(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: StartDirectDto,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConversationResponse> {
    const result = unwrap(
      await this.startDirect.execute({ principal, counterpartUserId: dto.userId, meta }),
    );
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return toConversationResponse(result.conversation);
  }

  @Post('groups')
  @RequirePermission(Permissions.messaging.createGroup)
  @HttpCode(HttpStatus.CREATED)
  async group(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateGroupDto,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<ConversationResponse> {
    return toConversationResponse(
      unwrap(
        await this.createGroup.execute({
          principal,
          title: dto.title,
          memberIds: dto.memberIds,
          meta,
        }),
      ),
    );
  }

  @Post('channels')
  @RequirePermission(Permissions.messaging.createChannel)
  @HttpCode(HttpStatus.CREATED)
  async channel(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateChannelDto,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<ConversationResponse> {
    return toConversationResponse(
      unwrap(
        await this.createChannel.execute({
          principal,
          title: dto.title,
          memberIds: dto.memberIds ?? [],
          publisherIds: dto.publisherIds ?? [],
          meta,
        }),
      ),
    );
  }

  @Get(':conversationId')
  @RequirePermission(Permissions.messaging.read)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<ConversationResponse> {
    return toConversationResponse(
      unwrap(await this.getConversation.execute({ principal, conversationId })),
    );
  }

  @Get(':conversationId/messages')
  @RequirePermission(Permissions.messaging.read)
  async messages(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Query() query: ListMessagesQuery,
  ): Promise<MessagePageResponse> {
    return toMessagePageResponse(
      unwrap(
        await this.listMessages.execute({
          principal,
          conversationId,
          before: query.before,
          after: query.after,
          limit: query.limit,
        }),
      ),
    );
  }

  @Post(':conversationId/messages/text')
  @RequirePermission(Permissions.messaging.send)
  async text(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() dto: SendTextDto,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MessageResponse> {
    return sent(
      response,
      await this.sendText.execute({
        principal,
        conversationId,
        clientMessageId: dto.clientMessageId,
        body: dto.body,
        replyToMessageId: dto.replyToMessageId ?? null,
        meta,
      }),
    );
  }

  @Post(':conversationId/messages/voice')
  @RequirePermission(Permissions.messaging.send)
  async voice(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() dto: SendMediaDto,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MessageResponse> {
    return sent(
      response,
      await this.sendVoice.execute(media(principal, conversationId, dto, meta)),
    );
  }

  @Post(':conversationId/messages/image')
  @RequirePermission(Permissions.messaging.send)
  async image(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() dto: SendMediaDto,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MessageResponse> {
    return sent(
      response,
      await this.sendImage.execute(media(principal, conversationId, dto, meta)),
    );
  }

  @Post(':conversationId/messages/file')
  @RequirePermission(Permissions.messaging.send)
  async file(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() dto: SendMediaDto,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MessageResponse> {
    return sent(response, await this.sendFile.execute(media(principal, conversationId, dto, meta)));
  }

  @Get(':conversationId/messages/:messageId/attachments/:fileAssetId/link')
  @RequirePermission(Permissions.messaging.read)
  async link(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Param('fileAssetId') fileAssetId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    return toLinkResponse(
      unwrap(
        await this.attachmentLink.execute({ principal, conversationId, messageId, fileAssetId }),
      ),
    );
  }

  @Post(':conversationId/read')
  @RequirePermission(Permissions.messaging.read)
  @HttpCode(HttpStatus.OK)
  async read(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() dto: MarkReadDto,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<{ lastReadSequence: number }> {
    return unwrap(
      await this.markRead.execute({ principal, conversationId, sequence: dto.sequence, meta }),
    );
  }

  @Get(':conversationId/participants')
  @RequirePermission(Permissions.messaging.read)
  async participants(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Query() query: ListParticipantsQuery,
  ): Promise<{ items: ParticipantResponse[]; nextCursor: string | null }> {
    const page = unwrap(
      await this.listParticipants.execute({
        principal,
        conversationId,
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
    return { items: page.items.map(toParticipantResponse), nextCursor: page.nextCursor };
  }

  @Post(':conversationId/participants')
  @RequirePermission(Permissions.messaging.read)
  @HttpCode(HttpStatus.OK)
  async add(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() dto: AddParticipantsDto,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<{ added: string[]; unchanged: string[] }> {
    return unwrap(
      await this.addParticipants.execute({
        principal,
        conversationId,
        userIds: dto.userIds,
        role: dto.role,
        meta,
      }),
    );
  }

  /**
   * Authenticated only at the edge: the conversation's owner (a member) and a
   * moderator (`messaging.manage`, not necessarily a member) may both remove,
   * and only the use case can tell which the caller is.
   */
  @Delete(':conversationId/participants/:userId')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('userId') userId: string,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<void> {
    unwrap(await this.removeParticipant.execute({ principal, conversationId, userId, meta }));
  }

  @Post(':conversationId/leave')
  @RequirePermission(Permissions.messaging.read)
  @HttpCode(HttpStatus.NO_CONTENT)
  async leave(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<void> {
    unwrap(await this.leaveConversation.execute({ principal, conversationId, meta }));
  }
}

function media(
  principal: Principal,
  conversationId: string,
  dto: SendMediaDto,
  meta: CallMetadata,
) {
  return {
    principal,
    conversationId,
    clientMessageId: dto.clientMessageId,
    fileAssetId: dto.fileAssetId,
    caption: dto.caption ?? null,
    replyToMessageId: dto.replyToMessageId ?? null,
    meta,
  };
}

/** 201 for a new message; 200 for a retry that returns the original. */
function sent(response: Response, result: Result<SentMessage>): MessageResponse {
  const { message, created } = unwrap(result);
  response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
  return toMessageResponse(message);
}

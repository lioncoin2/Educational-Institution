import { Body, Controller, Get, Param, Post, UseInterceptors } from '@nestjs/common';

import { RequestMetadata } from '../../../platform/http/call-metadata.decorator';
import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { DatabaseUnavailableInterceptor } from '../../../platform/http/database-unavailable.interceptor';
import { unwrap } from '../../../platform/http/http-failure';
import type { CallMetadata, Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import { GetCommunityChatUseCase } from '../application/community-chat.use-case';
import { PublishToCommunitiesUseCase } from '../application/publish-to-communities.use-case';
import { PublishToCommunitiesDto } from './dto/messaging.dto';
import {
  toConversationResponse,
  toPublicationResponse,
  type ConversationResponse,
  type PublicationResponse,
} from './responses';

/**
 * A community's chat, reached from the community. Everything after opening
 * it — messages, sends, read marks, attachments, realtime — uses the
 * ordinary conversation routes with the id this returns; each of those asks
 * Communities again on every request. There is no route here, or anywhere in
 * messaging, that adds, removes or lists a community chat's members.
 *
 * `messaging.read` is the coarse gate; `community.chat.read` is decided by
 * Communities inside the use case. A store that cannot be reached answers
 * 503, never a guess.
 */
@Controller('messaging/communities')
@UseInterceptors(DatabaseUnavailableInterceptor)
export class CommunityChatController {
  constructor(
    private readonly communityChat: GetCommunityChatUseCase,
    private readonly publish: PublishToCommunitiesUseCase,
  ) {}

  @Get(':communityId/conversation')
  @RequirePermission(Permissions.messaging.read)
  async conversation(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
  ): Promise<ConversationResponse> {
    return toConversationResponse(
      unwrap(await this.communityChat.execute({ principal, communityId })),
    );
  }

  /**
   * Publish one notice / file / image / voice recording to several communities
   * at once ("النشر الجماعي"). `messaging.send` is the coarse gate; each
   * community is then authorized on its own `community.chat.post`, so a viewer
   * reaches only the communities they may already post in. Partial failure is
   * normal and expected: the body carries a per-community outcome, and a retry
   * with the same `clientBatchId` re-posts only what is resent, idempotently.
   */
  @Post('publish')
  @RequirePermission(Permissions.messaging.send)
  async publishToCommunities(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: PublishToCommunitiesDto,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<PublicationResponse> {
    return toPublicationResponse(
      unwrap(
        await this.publish.execute({
          principal,
          clientBatchId: dto.clientBatchId,
          communityIds: dto.communityIds,
          kind: dto.kind,
          body: dto.body ?? null,
          fileAssetId: dto.fileAssetId ?? null,
          meta,
        }),
      ),
    );
  }
}

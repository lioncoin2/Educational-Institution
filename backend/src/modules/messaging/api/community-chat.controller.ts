import { Controller, Get, Param, UseInterceptors } from '@nestjs/common';

import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { DatabaseUnavailableInterceptor } from '../../../platform/http/database-unavailable.interceptor';
import { unwrap } from '../../../platform/http/http-failure';
import type { Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import { GetCommunityChatUseCase } from '../application/community-chat.use-case';
import { toConversationResponse, type ConversationResponse } from './responses';

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
  constructor(private readonly communityChat: GetCommunityChatUseCase) {}

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
}

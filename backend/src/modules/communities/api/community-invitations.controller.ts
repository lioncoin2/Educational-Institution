import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';

import { RequestMetadata } from '../../../platform/http/call-metadata.decorator';
import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { DatabaseUnavailableInterceptor } from '../../../platform/http/database-unavailable.interceptor';
import { unwrap } from '../../../platform/http/http-failure';
import type { CallMetadata, Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import {
  CreateInvitationUseCase,
  ListInvitationsUseCase,
  RevokeInvitationUseCase,
} from '../application/invitation.use-cases';
import { CreateInvitationDto, PageQuery } from './dto/communities.dto';
import { toInvitationResponse, toPageResponse } from './responses';

/**
 * A community's invitation links, nested under the community — which is
 * authorized before any link is loaded, so a link id is never an enumeration
 * surface. The token appears in exactly one response: the 201 that creates
 * the link.
 */
@Controller('communities/:communityId/invitations')
@UseInterceptors(DatabaseUnavailableInterceptor)
export class CommunityInvitationsController {
  constructor(
    private readonly createInvitation: CreateInvitationUseCase,
    private readonly listInvitations: ListInvitationsUseCase,
    private readonly revokeInvitation: RevokeInvitationUseCase,
  ) {}

  @Post()
  @RequirePermission(Permissions.communities.read)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @Body() dto: CreateInvitationDto,
    @RequestMetadata() meta: CallMetadata,
  ) {
    const created = unwrap(
      await this.createInvitation.execute({
        principal,
        communityId,
        expiresInSeconds: dto.expiresInSeconds,
        maxUses: dto.maxUses,
        meta,
      }),
    );
    return { invitation: toInvitationResponse(created.invitation), token: created.token };
  }

  @Get()
  @RequirePermission(Permissions.communities.read)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @Query() query: PageQuery,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toPageResponse(
      unwrap(
        await this.listInvitations.execute({
          principal,
          communityId,
          cursor: query.cursor,
          limit: query.limit,
          meta,
        }),
      ),
      toInvitationResponse,
    );
  }

  @Post(':invitationId/revoke')
  @RequirePermission(Permissions.communities.read)
  @HttpCode(HttpStatus.OK)
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @Param('invitationId') invitationId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toInvitationResponse(
      unwrap(await this.revokeInvitation.execute({ principal, communityId, invitationId, meta })),
    );
  }
}

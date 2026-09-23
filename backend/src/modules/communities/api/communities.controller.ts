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
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';

import { RequestMetadata } from '../../../platform/http/call-metadata.decorator';
import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { DatabaseUnavailableInterceptor } from '../../../platform/http/database-unavailable.interceptor';
import { unwrap } from '../../../platform/http/http-failure';
import { RateLimit } from '../../../platform/http/rate-limit';
import type { CallMetadata, Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import { CommunityRateLimits } from '../application/communities-settings';
import {
  ChangeCommunityStatusUseCase,
  CreateCommunityUseCase,
  GetCommunityUseCase,
  ListCommunitiesUseCase,
} from '../application/community.use-cases';
import { RedeemInvitationUseCase } from '../application/invitation.use-cases';
import {
  AddMembersUseCase,
  LeaveCommunityUseCase,
  ListMembersUseCase,
  RemoveMemberUseCase,
} from '../application/membership.use-cases';
import {
  AddMembersDto,
  CreateCommunityDto,
  ListCommunitiesQuery,
  PageQuery,
  RedeemInvitationDto,
} from './dto/communities.dto';
import {
  toAddMembersResponse,
  toCommunityResponse,
  toMemberResponse,
  toPageResponse,
} from './responses';

/**
 * /communities — communities, their members, and joining by link.
 *
 * The edge permission is `communities.read` for every route but creation
 * (`communities.create`). It is never the decision: every use case asks
 * again, with the community in context, through COMMUNITY_AUTHORIZATION —
 * so a route reached without its guard (a job, a handler) is exactly as safe.
 * A non-member is told what anyone is told about a community that does not
 * exist. Controllers validate and unwrap; they decide nothing.
 */
@Controller('communities')
@UseInterceptors(DatabaseUnavailableInterceptor)
export class CommunitiesController {
  constructor(
    private readonly listCommunities: ListCommunitiesUseCase,
    private readonly createCommunity: CreateCommunityUseCase,
    private readonly getCommunity: GetCommunityUseCase,
    private readonly changeStatus: ChangeCommunityStatusUseCase,
    private readonly listMembers: ListMembersUseCase,
    private readonly addMembers: AddMembersUseCase,
    private readonly removeMember: RemoveMemberUseCase,
    private readonly leaveCommunity: LeaveCommunityUseCase,
    private readonly redeemInvitation: RedeemInvitationUseCase,
  ) {}

  @Get()
  @RequirePermission(Permissions.communities.read)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListCommunitiesQuery,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toPageResponse(
      unwrap(
        await this.listCommunities.execute({
          principal,
          scope: query.scope ?? 'mine',
          cursor: query.cursor,
          limit: query.limit,
          meta,
        }),
      ),
      toCommunityResponse,
    );
  }

  @Post()
  @RequirePermission(Permissions.communities.create)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateCommunityDto,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toCommunityResponse(
      unwrap(await this.createCommunity.execute({ principal, title: dto.title, meta })),
    );
  }

  /**
   * Joining by link. The token is the only input — it names the community —
   * and travels in the body only. 201 for a new member, 200 for someone who
   * already was one. Limited per address here, and per person in the use case.
   */
  @Post('join')
  @RequirePermission(Permissions.communities.read)
  @RateLimit(CommunityRateLimits.joinsPerIp)
  async join(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: RedeemInvitationDto,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = unwrap(
      await this.redeemInvitation.execute({ principal, token: dto.token, meta }),
    );
    response.status(result.kind === 'joined' ? HttpStatus.CREATED : HttpStatus.OK);
    return toCommunityResponse(result.community);
  }

  @Get(':communityId')
  @RequirePermission(Permissions.communities.read)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toCommunityResponse(
      unwrap(await this.getCommunity.execute({ principal, communityId, meta })),
    );
  }

  @Post(':communityId/lock')
  @RequirePermission(Permissions.communities.read)
  @HttpCode(HttpStatus.OK)
  async lock(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toCommunityResponse(
      unwrap(await this.changeStatus.execute({ principal, communityId, to: 'LOCKED', meta })),
    );
  }

  @Post(':communityId/unlock')
  @RequirePermission(Permissions.communities.read)
  @HttpCode(HttpStatus.OK)
  async unlock(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toCommunityResponse(
      unwrap(await this.changeStatus.execute({ principal, communityId, to: 'OPEN', meta })),
    );
  }

  @Get(':communityId/members')
  @RequirePermission(Permissions.communities.read)
  async members(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @Query() query: PageQuery,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toPageResponse(
      unwrap(
        await this.listMembers.execute({
          principal,
          communityId,
          cursor: query.cursor,
          limit: query.limit,
          meta,
        }),
      ),
      toMemberResponse,
    );
  }

  /** 201 when anyone was added; 200 when everyone named already was a member. */
  @Post(':communityId/members')
  @RequirePermission(Permissions.communities.read)
  async add(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @Body() dto: AddMembersDto,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = unwrap(
      await this.addMembers.execute({ principal, communityId, userIds: dto.userIds, meta }),
    );
    response.status(result.anyAdded ? HttpStatus.CREATED : HttpStatus.OK);
    return toAddMembersResponse(result.view);
  }

  @Delete(':communityId/members/:userId')
  @RequirePermission(Permissions.communities.read)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @Param('userId') userId: string,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<void> {
    unwrap(await this.removeMember.execute({ principal, communityId, userId, meta }));
  }

  @Post(':communityId/leave')
  @RequirePermission(Permissions.communities.read)
  @HttpCode(HttpStatus.NO_CONTENT)
  async leave(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<void> {
    unwrap(await this.leaveCommunity.execute({ principal, communityId, meta }));
  }
}

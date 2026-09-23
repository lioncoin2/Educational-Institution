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
import type { CallMetadata, Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import {
  GrantCapabilitiesUseCase,
  ListGrantsUseCase,
  RevokeGrantUseCase,
} from '../application/delegation.use-cases';
import { GrantCapabilitiesDto, ListGrantsQuery } from './dto/communities.dto';
import { toGrantCapabilitiesResponse, toGrantResponse, toPageResponse } from './responses';

/**
 * A community's delegated capabilities (P3), nested under the community —
 * which is authorized before any grant is loaded, so a grant id is never an
 * enumeration surface. Granting and revoking need `communities.moderate` at
 * the edge, the ceiling of every delegable capability; listing needs only
 * `communities.read`, since a holder may list their own grants. The use cases
 * decide: only the owner grants, revokes, and sees every grant.
 */
@Controller('communities/:communityId/grants')
@UseInterceptors(DatabaseUnavailableInterceptor)
export class CommunityGrantsController {
  constructor(
    private readonly grantCapabilities: GrantCapabilitiesUseCase,
    private readonly listGrants: ListGrantsUseCase,
    private readonly revokeGrant: RevokeGrantUseCase,
  ) {}

  @Get()
  @RequirePermission(Permissions.communities.read)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @Query() query: ListGrantsQuery,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toPageResponse(
      unwrap(
        await this.listGrants.execute({
          principal,
          communityId,
          userId: query.userId,
          capability: query.capability,
          cursor: query.cursor,
          limit: query.limit,
          meta,
        }),
      ),
      toGrantResponse,
    );
  }

  /** 201 when any grant was created; 200 when the member already held every one named. */
  @Post()
  @RequirePermission(Permissions.communities.moderate)
  async grant(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @Body() dto: GrantCapabilitiesDto,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = unwrap(
      await this.grantCapabilities.execute({
        principal,
        communityId,
        userId: dto.userId,
        capabilities: dto.capabilities,
        meta,
      }),
    );
    response.status(result.anyCreated ? HttpStatus.CREATED : HttpStatus.OK);
    return toGrantCapabilitiesResponse(result.view);
  }

  /** 204, and 204 again for a grant already ended. */
  @Delete(':grantId')
  @RequirePermission(Permissions.communities.moderate)
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('communityId') communityId: string,
    @Param('grantId') grantId: string,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<void> {
    unwrap(await this.revokeGrant.execute({ principal, communityId, grantId, meta }));
  }
}

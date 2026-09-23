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
} from '@nestjs/common';

import { RequestMetadata } from '../../../platform/http/call-metadata.decorator';
import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import type { CallMetadata, Principal } from '../../../shared';
import { ChangeAccountStatusUseCase } from '../application/admin/account-status.use-case';
import { CreateUserUseCase } from '../application/admin/create-user.use-case';
import { ResetPasswordUseCase } from '../application/admin/password-reset.use-case';
import { GetUserUseCase, ListUsersUseCase } from '../application/admin/read-users.use-cases';
import {
  AssignRoleUseCase,
  RevokeRoleUseCase,
} from '../application/admin/role-assignment.use-cases';
import { RevokeUserSessionsUseCase } from '../application/admin/user-sessions.use-case';
import { Permissions } from '../contracts/permissions';
import { RequirePermission } from '../contracts/route-access';
import {
  AssignRoleDto,
  ChangeStatusDto,
  CreateUserDto,
  ListUsersQuery,
  ResetPasswordDto,
} from './dto/admin-users.dto';
import { toUserAccountResponse, type UserAccountResponse } from './responses';

/**
 * Account provisioning and administration by staff.
 *
 * Kept apart from /auth on purpose: different callers, different permissions,
 * different audit trail. The permission on each route is the coarse gate; each
 * use case re-checks it and adds the checks a route cannot express — that the
 * target is not the caller, and does not outrank them.
 */
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly listUsers: ListUsersUseCase,
    private readonly getUser: GetUserUseCase,
    private readonly createUser: CreateUserUseCase,
    private readonly assignRole: AssignRoleUseCase,
    private readonly revokeRole: RevokeRoleUseCase,
    private readonly changeStatus: ChangeAccountStatusUseCase,
    private readonly resetPassword: ResetPasswordUseCase,
    private readonly revokeSessions: RevokeUserSessionsUseCase,
  ) {}

  @Get()
  @RequirePermission(Permissions.users.read)
  async list(
    @CurrentPrincipal() actor: Principal,
    @Query() query: ListUsersQuery,
  ): Promise<{
    readonly items: readonly UserAccountResponse[];
    readonly nextCursor: string | null;
  }> {
    const page = unwrap(
      await this.listUsers.execute({
        actor,
        page: { limit: query.limit ?? 50, cursor: query.cursor },
      }),
    );
    return { items: page.items.map(toUserAccountResponse), nextCursor: page.nextCursor ?? null };
  }

  @Post()
  @RequirePermission(Permissions.users.manage)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentPrincipal() actor: Principal,
    @Body() dto: CreateUserDto,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<UserAccountResponse> {
    return toUserAccountResponse(
      unwrap(
        await this.createUser.execute({
          actor,
          displayName: dto.displayName,
          identifierKind: dto.identifierType ?? 'email',
          identifier: dto.identifier,
          initialPassword: dto.initialPassword,
          meta,
        }),
      ),
    );
  }

  @Get(':userId')
  @RequirePermission(Permissions.users.read)
  async get(
    @CurrentPrincipal() actor: Principal,
    @Param('userId') userId: string,
  ): Promise<UserAccountResponse> {
    return toUserAccountResponse(unwrap(await this.getUser.execute({ actor, userId })));
  }

  @Post(':userId/roles')
  @RequirePermission(Permissions.roles.assign)
  @HttpCode(HttpStatus.OK)
  async grantRole(
    @CurrentPrincipal() actor: Principal,
    @Param('userId') userId: string,
    @Body() dto: AssignRoleDto,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<UserAccountResponse> {
    return toUserAccountResponse(
      unwrap(await this.assignRole.execute({ actor, userId, role: dto.role, meta })),
    );
  }

  @Delete(':userId/roles/:role')
  @RequirePermission(Permissions.roles.assign)
  @HttpCode(HttpStatus.OK)
  async removeRole(
    @CurrentPrincipal() actor: Principal,
    @Param('userId') userId: string,
    @Param('role') role: string,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<UserAccountResponse> {
    return toUserAccountResponse(
      unwrap(await this.revokeRole.execute({ actor, userId, role, meta })),
    );
  }

  @Post(':userId/status')
  @RequirePermission(Permissions.users.manage)
  @HttpCode(HttpStatus.OK)
  async setStatus(
    @CurrentPrincipal() actor: Principal,
    @Param('userId') userId: string,
    @Body() dto: ChangeStatusDto,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<UserAccountResponse> {
    return toUserAccountResponse(
      unwrap(await this.changeStatus.execute({ actor, userId, status: dto.status, meta })),
    );
  }

  @Post(':userId/password')
  @RequirePermission(Permissions.users.manage)
  @HttpCode(HttpStatus.NO_CONTENT)
  async setPassword(
    @CurrentPrincipal() actor: Principal,
    @Param('userId') userId: string,
    @Body() dto: ResetPasswordDto,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<void> {
    unwrap(await this.resetPassword.execute({ actor, userId, newPassword: dto.newPassword, meta }));
  }

  @Delete(':userId/sessions')
  @RequirePermission(Permissions.sessions.manage)
  @HttpCode(HttpStatus.OK)
  async endAllSessions(
    @CurrentPrincipal() actor: Principal,
    @Param('userId') userId: string,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<{ readonly sessionsEnded: number }> {
    return unwrap(await this.revokeSessions.execute({ actor, userId, meta }));
  }
}

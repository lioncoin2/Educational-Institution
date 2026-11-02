import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import type { Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import { AcknowledgeTaskUseCase } from '../application/respond/acknowledge-task.use-case';
import { CompleteTaskUseCase } from '../application/respond/complete-task.use-case';
import {
  GetMyTaskByTaskUseCase,
  GetMyTaskUseCase,
  ListMyTasksUseCase,
} from '../application/respond/read-my-tasks.use-cases';
import { WriteOwnReportUseCase } from '../application/respond/write-own-report.use-case';
import { CompleteTaskDto, MyTasksQuery, WriteReportDto } from './dto/my-tasks.dto';
import {
  toAssignmentResponse,
  toMyTaskDetailResponse,
  toMyTaskResponse,
  type AssignmentResponse,
  type MyTaskDetailResponse,
  type MyTaskResponse,
} from './responses/assignment.responses';
import { toReportResponse, type ReportResponse } from './responses/report.responses';
import type { PageResponse } from './responses/wire';

/**
 * A recipient's own tasks (roadmap §3): list, read, acknowledge, complete and
 * report — `tasks.respond`, and the assignment must be the caller's own (checked
 * in every use case; anyone else's reads as non-existent).
 */
@Controller('my-tasks')
export class MyTasksController {
  constructor(
    private readonly listMine: ListMyTasksUseCase,
    private readonly getMine: GetMyTaskUseCase,
    private readonly getMineByTask: GetMyTaskByTaskUseCase,
    private readonly acknowledge: AcknowledgeTaskUseCase,
    private readonly complete: CompleteTaskUseCase,
    private readonly writeReport: WriteOwnReportUseCase,
  ) {}

  @Get()
  @RequirePermission(Permissions.tasks.respond)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: MyTasksQuery,
  ): Promise<PageResponse<MyTaskResponse>> {
    const page = unwrap(
      await this.listMine.execute({
        principal,
        scope: query.scope ?? 'OPEN',
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
    return { items: page.items.map(toMyTaskResponse), nextCursor: page.nextCursor ?? null };
  }

  @Get('by-task/:taskId')
  @RequirePermission(Permissions.tasks.respond)
  async getByTask(
    @CurrentPrincipal() principal: Principal,
    @Param('taskId') taskId: string,
  ): Promise<MyTaskDetailResponse> {
    return toMyTaskDetailResponse(unwrap(await this.getMineByTask.execute({ principal, taskId })));
  }

  @Get(':assignmentId')
  @RequirePermission(Permissions.tasks.respond)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('assignmentId') assignmentId: string,
  ): Promise<MyTaskDetailResponse> {
    return toMyTaskDetailResponse(unwrap(await this.getMine.execute({ principal, assignmentId })));
  }

  @Post(':assignmentId/acknowledge')
  @RequirePermission(Permissions.tasks.respond)
  @HttpCode(HttpStatus.OK)
  async acknowledgeTask(
    @CurrentPrincipal() principal: Principal,
    @Param('assignmentId') assignmentId: string,
  ): Promise<AssignmentResponse> {
    return toAssignmentResponse(
      unwrap(await this.acknowledge.execute({ principal, assignmentId })),
    );
  }

  @Post(':assignmentId/complete')
  @RequirePermission(Permissions.tasks.respond)
  @HttpCode(HttpStatus.OK)
  async completeTask(
    @CurrentPrincipal() principal: Principal,
    @Param('assignmentId') assignmentId: string,
    @Body() dto: CompleteTaskDto,
  ): Promise<AssignmentResponse> {
    return toAssignmentResponse(
      unwrap(await this.complete.execute({ principal, assignmentId, report: dto.report })),
    );
  }

  @Put(':assignmentId/report')
  @RequirePermission(Permissions.tasks.respond)
  async report(
    @CurrentPrincipal() principal: Principal,
    @Param('assignmentId') assignmentId: string,
    @Body() dto: WriteReportDto,
  ): Promise<ReportResponse> {
    return toReportResponse(
      unwrap(
        await this.writeReport.execute({
          principal,
          assignmentId,
          version: dto.version,
          body: dto.body,
        }),
      ),
    );
  }
}

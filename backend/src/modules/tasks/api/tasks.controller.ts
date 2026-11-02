import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import type { Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import { CancelTaskUseCase } from '../application/manage/cancel-task.use-case';
import { EditTaskUseCase } from '../application/manage/edit-task.use-case';
import { PublishTaskUseCase } from '../application/manage/publish-task.use-case';
import {
  GetTaskUseCase,
  ListTasksUseCase,
  TaskHistoryUseCase,
  TrackTaskUseCase,
} from '../application/manage/read-tasks.use-cases';
import { ReassignAssignmentUseCase } from '../application/manage/reassign-assignment.use-case';
import { RemindNonRespondersUseCase } from '../application/manage/remind-non-responders.use-case';
import { ReopenTaskUseCase } from '../application/manage/reopen-task.use-case';
import { RepublishTaskUseCase } from '../application/templates/republish-task.use-case';
import { PagedFilterQuery, toTaskFilter } from './dto/task-filter.dto';
import {
  EditTaskDto,
  PageQuery,
  PublishTaskDto,
  ReassignDto,
  TrackTaskQuery,
} from './dto/tasks.dto';
import { RepublishTaskDto } from './dto/templates.dto';
import { toLogEntryResponse, type LogEntryResponse } from './responses/admin.responses';
import {
  toAssignmentResponse,
  toTrackingRow,
  type AssignmentResponse,
  type TrackingRowResponse,
} from './responses/assignment.responses';
import {
  toDetailResponse,
  toOverviewResponse,
  toTaskResponse,
  type TaskDetailResponse,
  type TaskOverviewResponse,
  type TaskResponse,
} from './responses/task.responses';
import type { PageResponse } from './responses/wire';

/**
 * The administration's task routes (ADR 0052): publish, search, follow up,
 * edit, cancel, reopen, remind, reassign, the operation log — `tasks.manage`;
 * re-publishing — `tasks.template`. The use cases re-authorize every call.
 */
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly publishTask: PublishTaskUseCase,
    private readonly listTasks: ListTasksUseCase,
    private readonly getTask: GetTaskUseCase,
    private readonly editTask: EditTaskUseCase,
    private readonly cancelTask: CancelTaskUseCase,
    private readonly reopenTask: ReopenTaskUseCase,
    private readonly remind: RemindNonRespondersUseCase,
    private readonly track: TrackTaskUseCase,
    private readonly reassign: ReassignAssignmentUseCase,
    private readonly history: TaskHistoryUseCase,
    private readonly republish: RepublishTaskUseCase,
  ) {}

  @Post()
  @RequirePermission(Permissions.tasks.manage)
  async publish(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: PublishTaskDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TaskResponse> {
    const outcome = unwrap(await this.publishTask.execute({ principal, ...dto }));
    // A fresh task is 201; an idempotent retry returns the first one as 200.
    response.status(outcome.status === 'created' ? HttpStatus.CREATED : HttpStatus.OK);
    return toTaskResponse(outcome.task);
  }

  @Get()
  @RequirePermission(Permissions.tasks.manage)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: PagedFilterQuery,
  ): Promise<PageResponse<TaskOverviewResponse>> {
    const page = unwrap(
      await this.listTasks.execute({
        principal,
        filter: toTaskFilter(query),
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
    return { items: page.items.map(toOverviewResponse), nextCursor: page.nextCursor ?? null };
  }

  @Get(':taskId')
  @RequirePermission(Permissions.tasks.manage)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('taskId') taskId: string,
  ): Promise<TaskDetailResponse> {
    return toDetailResponse(unwrap(await this.getTask.execute({ principal, taskId })));
  }

  @Patch(':taskId')
  @RequirePermission(Permissions.tasks.manage)
  async edit(
    @CurrentPrincipal() principal: Principal,
    @Param('taskId') taskId: string,
    @Body() dto: EditTaskDto,
  ): Promise<TaskResponse> {
    return toTaskResponse(unwrap(await this.editTask.execute({ principal, taskId, ...dto })));
  }

  @Post(':taskId/cancel')
  @RequirePermission(Permissions.tasks.manage)
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('taskId') taskId: string,
  ): Promise<TaskResponse> {
    return toTaskResponse(unwrap(await this.cancelTask.execute({ principal, taskId })));
  }

  @Post(':taskId/reopen')
  @RequirePermission(Permissions.tasks.manage)
  @HttpCode(HttpStatus.OK)
  async reopen(
    @CurrentPrincipal() principal: Principal,
    @Param('taskId') taskId: string,
  ): Promise<TaskResponse> {
    return toTaskResponse(unwrap(await this.reopenTask.execute({ principal, taskId })));
  }

  @Post(':taskId/remind')
  @RequirePermission(Permissions.tasks.manage)
  @HttpCode(HttpStatus.OK)
  async remindNonResponders(
    @CurrentPrincipal() principal: Principal,
    @Param('taskId') taskId: string,
  ): Promise<{ readonly reminded: number }> {
    return unwrap(await this.remind.execute({ principal, taskId }));
  }

  @Get(':taskId/assignments')
  @RequirePermission(Permissions.tasks.manage)
  async assignments(
    @CurrentPrincipal() principal: Principal,
    @Param('taskId') taskId: string,
    @Query() query: TrackTaskQuery,
  ): Promise<PageResponse<TrackingRowResponse>> {
    const page = unwrap(
      await this.track.execute({
        principal,
        taskId,
        filter: query.filter ?? 'ALL',
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
    return {
      items: page.items.map((row) => toTrackingRow(row, page.names)),
      nextCursor: page.nextCursor ?? null,
    };
  }

  @Post(':taskId/assignments/:assignmentId/reassign')
  @RequirePermission(Permissions.tasks.manage)
  @HttpCode(HttpStatus.OK)
  async reassignAssignment(
    @CurrentPrincipal() principal: Principal,
    @Param('taskId') taskId: string,
    @Param('assignmentId') assignmentId: string,
    @Body() dto: ReassignDto,
  ): Promise<AssignmentResponse> {
    return toAssignmentResponse(
      unwrap(
        await this.reassign.execute({ principal, taskId, assignmentId, toUserId: dto.toUserId }),
      ),
    );
  }

  @Get(':taskId/history')
  @RequirePermission(Permissions.tasks.manage)
  async log(
    @CurrentPrincipal() principal: Principal,
    @Param('taskId') taskId: string,
    @Query() query: PageQuery,
  ): Promise<PageResponse<LogEntryResponse>> {
    const page = unwrap(
      await this.history.execute({ principal, taskId, cursor: query.cursor, limit: query.limit }),
    );
    return {
      items: page.items.map((e) => toLogEntryResponse(e, page.names)),
      nextCursor: page.nextCursor ?? null,
    };
  }

  @Post(':taskId/republish')
  @RequirePermission(Permissions.tasks.template)
  async republishTask(
    @CurrentPrincipal() principal: Principal,
    @Param('taskId') taskId: string,
    @Body() dto: RepublishTaskDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TaskResponse> {
    const outcome = unwrap(await this.republish.execute({ principal, taskId, ...dto }));
    response.status(outcome.status === 'created' ? HttpStatus.CREATED : HttpStatus.OK);
    return toTaskResponse(outcome.task);
  }
}

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
import {
  CancelLessonUseCase,
  GetLessonUseCase,
  ListLessonsUseCase,
  RescheduleLessonUseCase,
  ScheduleLessonUseCase,
} from '../application/lesson.use-cases';
import { CreateLessonDto, ListLessonsQuery, UpdateLessonDto } from './dto/operations.dto';
import {
  toLessonPageResponse,
  toLessonResponse,
  type LessonPageResponse,
  type LessonResponse,
} from './responses';

/**
 * Scheduling of individual dated lessons. Every route requires
 * `operations.schedule_manage` (owner/admin only) — read as well as write, so a
 * guessed lesson id reveals nothing to anyone who may not manage the schedule.
 * The use cases re-authorize; this guard is the outer edge, not the boundary.
 */
@Controller('operations')
export class OperationsController {
  constructor(
    private readonly scheduleLesson: ScheduleLessonUseCase,
    private readonly listLessons: ListLessonsUseCase,
    private readonly getLesson: GetLessonUseCase,
    private readonly rescheduleLesson: RescheduleLessonUseCase,
    private readonly cancelLesson: CancelLessonUseCase,
  ) {}

  @Post('lessons')
  @RequirePermission(Permissions.operations.scheduleManage)
  async schedule(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateLessonDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LessonResponse> {
    const outcome = unwrap(
      await this.scheduleLesson.execute({
        principal,
        halaqaId: dto.halaqaId,
        title: dto.title,
        date: dto.date,
        time: dto.time,
        timezone: dto.timezone,
        clientRequestId: dto.clientRequestId,
      }),
    );
    // A fresh schedule is 201; an idempotent retry returns the existing one as 200.
    response.status(outcome.status === 'created' ? HttpStatus.CREATED : HttpStatus.OK);
    return toLessonResponse(outcome.lesson);
  }

  @Get('lessons')
  @RequirePermission(Permissions.operations.scheduleManage)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListLessonsQuery,
  ): Promise<LessonPageResponse> {
    return toLessonPageResponse(
      unwrap(
        await this.listLessons.execute({
          principal,
          halaqaId: query.halaqaId,
          cursor: query.cursor,
          limit: query.limit,
        }),
      ),
    );
  }

  @Get('lessons/:lessonId')
  @RequirePermission(Permissions.operations.scheduleManage)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('lessonId') lessonId: string,
  ): Promise<LessonResponse> {
    return toLessonResponse(unwrap(await this.getLesson.execute({ principal, lessonId })));
  }

  @Patch('lessons/:lessonId')
  @RequirePermission(Permissions.operations.scheduleManage)
  async reschedule(
    @CurrentPrincipal() principal: Principal,
    @Param('lessonId') lessonId: string,
    @Body() dto: UpdateLessonDto,
  ): Promise<LessonResponse> {
    return toLessonResponse(
      unwrap(
        await this.rescheduleLesson.execute({
          principal,
          lessonId,
          date: dto.date,
          time: dto.time,
          timezone: dto.timezone,
          title: dto.title,
        }),
      ),
    );
  }

  @Post('lessons/:lessonId/cancel')
  @RequirePermission(Permissions.operations.scheduleManage)
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('lessonId') lessonId: string,
  ): Promise<LessonResponse> {
    return toLessonResponse(unwrap(await this.cancelLesson.execute({ principal, lessonId })));
  }
}

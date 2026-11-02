import {
  Body,
  Controller,
  Delete,
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
import {
  DeleteReportUseCase,
  EditReportUseCase,
} from '../application/reports/administer-report.use-cases';
import {
  GetReportUseCase,
  ListReportsUseCase,
} from '../application/reports/read-reports.use-cases';
import { ReviewReportUseCase } from '../application/reports/review-report.use-case';
import { EditReportDto, ReportsQuery, ReviewReportDto } from './dto/reports.dto';
import { toTaskFilter } from './dto/task-filter.dto';
import {
  toReportDetailResponse,
  toReportResponse,
  toSummaryResponse,
  type ReportDetailResponse,
  type ReportResponse,
  type ReportSummaryResponse,
} from './responses/report.responses';
import type { PageResponse } from './responses/wire';

/**
 * The reports page and its review (roadmap §5–§7) — `tasks.manage`: every
 * member of the administration, and the owner, reads, reviews, edits and
 * deletes any report.
 */
@Controller('task-reports')
export class TaskReportsController {
  constructor(
    private readonly listReports: ListReportsUseCase,
    private readonly getReport: GetReportUseCase,
    private readonly reviewReport: ReviewReportUseCase,
    private readonly editReport: EditReportUseCase,
    private readonly deleteReport: DeleteReportUseCase,
  ) {}

  @Get()
  @RequirePermission(Permissions.tasks.manage)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ReportsQuery,
  ): Promise<PageResponse<ReportSummaryResponse>> {
    const page = unwrap(
      await this.listReports.execute({
        principal,
        filter: {
          ...toTaskFilter(query),
          ...(query.category === undefined ? {} : { category: query.category }),
        },
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
    return {
      items: page.items.map((s) => toSummaryResponse(s, page.names)),
      nextCursor: page.nextCursor ?? null,
    };
  }

  @Get(':reportId')
  @RequirePermission(Permissions.tasks.manage)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('reportId') reportId: string,
  ): Promise<ReportDetailResponse> {
    return toReportDetailResponse(unwrap(await this.getReport.execute({ principal, reportId })));
  }

  @Post(':reportId/review')
  @RequirePermission(Permissions.tasks.manage)
  @HttpCode(HttpStatus.OK)
  async review(
    @CurrentPrincipal() principal: Principal,
    @Param('reportId') reportId: string,
    @Body() dto: ReviewReportDto,
  ): Promise<ReportResponse> {
    return toReportResponse(
      unwrap(await this.reviewReport.execute({ principal, reportId, ...dto })),
    );
  }

  @Put(':reportId')
  @RequirePermission(Permissions.tasks.manage)
  async edit(
    @CurrentPrincipal() principal: Principal,
    @Param('reportId') reportId: string,
    @Body() dto: EditReportDto,
  ): Promise<ReportResponse> {
    return toReportResponse(unwrap(await this.editReport.execute({ principal, reportId, ...dto })));
  }

  @Delete(':reportId')
  @RequirePermission(Permissions.tasks.manage)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param('reportId') reportId: string,
  ): Promise<ReportResponse> {
    return toReportResponse(unwrap(await this.deleteReport.execute({ principal, reportId })));
  }
}

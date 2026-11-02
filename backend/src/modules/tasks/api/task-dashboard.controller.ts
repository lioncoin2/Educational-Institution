import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import type { Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import {
  ExportTasksUseCase,
  TaskDashboardUseCase,
} from '../application/dashboard/dashboard.use-cases';
import { ExportQuery } from './dto/dashboard.dto';
import { TaskFilterQuery, toTaskFilter } from './dto/task-filter.dto';
import { toCsv } from './export/csv-export';
import { exportTable } from './export/export-table';
import { toPrintableHtml } from './export/html-export';
import { toDashboardResponse, type DashboardResponse } from './responses/admin.responses';

/** The dashboard and its export (roadmap §12–§13) — `tasks.manage`. */
@Controller('task-dashboard')
export class TaskDashboardController {
  constructor(
    private readonly dashboard: TaskDashboardUseCase,
    private readonly exportTasks: ExportTasksUseCase,
  ) {}

  @Get()
  @RequirePermission(Permissions.tasks.manage)
  async summary(
    @CurrentPrincipal() principal: Principal,
    @Query() query: TaskFilterQuery,
  ): Promise<DashboardResponse> {
    return toDashboardResponse(
      unwrap(await this.dashboard.execute({ principal, filter: toTaskFilter(query) })),
    );
  }

  @Get('export')
  @RequirePermission(Permissions.tasks.manage)
  async export(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ExportQuery,
    @Res() response: Response,
  ): Promise<void> {
    const result = unwrap(
      await this.exportTasks.execute({ principal, filter: toTaskFilter(query) }),
    );
    const table = exportTable(result.rows, result.names);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Export-Truncated', String(result.truncated));
    if ((query.format ?? 'csv') === 'csv') {
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', 'attachment; filename="tasks-report.csv"');
      response.send(toCsv(table));
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    response.send(
      toPrintableHtml(table, {
        title: 'تقرير المهام',
        filters: describeFilters(query),
        truncated: result.truncated,
      }),
    );
  }
}

/** The chosen filters, as the printed report states them. */
function describeFilters(query: TaskFilterQuery): string[] {
  const lines: string[] = [];
  if (query.from !== undefined) lines.push(`من: ${query.from}`);
  if (query.to !== undefined) lines.push(`إلى: ${query.to}`);
  if (query.audience !== undefined) lines.push(`الفئة: ${query.audience}`);
  if (query.kind !== undefined) lines.push(`النوع: ${query.kind}`);
  if (query.state !== undefined) lines.push(`الحالة: ${query.state}`);
  if (query.reportStatus !== undefined) lines.push(`حالة التقرير: ${query.reportStatus}`);
  if (query.q !== undefined) lines.push(`البحث: ${query.q}`);
  return lines;
}

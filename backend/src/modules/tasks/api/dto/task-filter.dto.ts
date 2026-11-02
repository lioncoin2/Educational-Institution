import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import {
  REPORT_STATUSES,
  TASK_AUDIENCES,
  TASK_KINDS,
  type TaskFilterView,
} from '../../application/views';

const ID_MAX = 128;
const TEXT_MAX = 200;
const CURSOR_MAX = 512;
const STATES = ['ACTIVE', 'ARCHIVED', 'CANCELLED'] as const;

/** The common filters of search, the reports page, the dashboard and the export (roadmap §12–§15). */
export class TaskFilterQuery {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsIn(TASK_AUDIENCES)
  audience?: (typeof TASK_AUDIENCES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  communityId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  personId?: string;

  @IsOptional()
  @IsIn(TASK_KINDS)
  kind?: (typeof TASK_KINDS)[number];

  @IsOptional()
  @IsIn(STATES)
  state?: (typeof STATES)[number];

  @IsOptional()
  @IsIn(REPORT_STATUSES)
  reportStatus?: (typeof REPORT_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(TEXT_MAX)
  q?: string;
}

export class PagedFilterQuery extends TaskFilterQuery {
  @IsOptional()
  @IsString()
  @MaxLength(CURSOR_MAX)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** The query's filters as the use cases take them. */
export function toTaskFilter(query: TaskFilterQuery): TaskFilterView {
  return {
    ...(query.from === undefined ? {} : { from: new Date(query.from) }),
    ...(query.to === undefined ? {} : { to: new Date(query.to) }),
    ...(query.audience === undefined ? {} : { audience: query.audience }),
    ...(query.communityId === undefined ? {} : { communityId: query.communityId }),
    ...(query.personId === undefined ? {} : { personId: query.personId }),
    ...(query.kind === undefined ? {} : { kind: query.kind }),
    ...(query.state === undefined ? {} : { state: query.state }),
    ...(query.reportStatus === undefined ? {} : { reportStatus: query.reportStatus }),
    ...(query.q === undefined ? {} : { text: query.q }),
  };
}

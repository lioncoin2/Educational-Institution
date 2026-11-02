import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { REPORT_BODY_MAX } from '../../application/views';

const CURSOR_MAX = 512;
const SCOPES = ['OPEN', 'DONE'] as const;

export class MyTasksQuery {
  @IsOptional()
  @IsIn(SCOPES)
  scope?: (typeof SCOPES)[number];

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

export class CompleteTaskDto {
  @IsOptional()
  @IsString()
  @MaxLength(REPORT_BODY_MAX * 4)
  report?: string | null;
}

export class WriteReportDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @MaxLength(REPORT_BODY_MAX * 4)
  body!: string;
}

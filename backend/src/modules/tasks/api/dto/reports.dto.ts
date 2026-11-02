import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { REPORT_BODY_MAX, REPORT_CATEGORIES, REVIEW_NOTE_MAX } from '../../application/views';
import { PagedFilterQuery } from './task-filter.dto';

export class ReportsQuery extends PagedFilterQuery {
  @IsOptional()
  @IsIn(REPORT_CATEGORIES)
  category?: (typeof REPORT_CATEGORIES)[number];
}

export class ReviewReportDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;

  @IsIn(['APPROVED', 'CHANGES_REQUESTED'])
  decision!: 'APPROVED' | 'CHANGES_REQUESTED';

  @IsOptional()
  @IsString()
  @MaxLength(REVIEW_NOTE_MAX * 4)
  note?: string | null;
}

export class EditReportDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @MaxLength(REPORT_BODY_MAX * 4)
  body!: string;
}

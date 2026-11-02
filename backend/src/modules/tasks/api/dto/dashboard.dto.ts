import { IsIn, IsOptional } from 'class-validator';

import { TaskFilterQuery } from './task-filter.dto';

/** CSV opens in Excel; HTML is the print-ready report the browser saves as PDF (ADR 0052 §12). */
export const EXPORT_FORMATS = ['csv', 'html'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export class ExportQuery extends TaskFilterQuery {
  @IsOptional()
  @IsIn(EXPORT_FORMATS)
  format?: ExportFormat;
}

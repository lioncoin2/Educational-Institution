import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  APPROVAL_MODES,
  TASK_AUDIENCES,
  TASK_BODY_MAX,
  TASK_BUTTONS,
  TASK_KINDS,
  TASK_TITLE_MAX,
} from '../../application/views';

const ID_MAX = 128;
const CURSOR_MAX = 512;
const ASSIGNMENT_FILTERS = [
  'ALL',
  'RESPONDED',
  'NOT_RESPONDED',
  'COMPLETED',
  'NOT_COMPLETED',
] as const;

/**
 * Transport shapes for the administration's task routes. These are coarse edge
 * guards; the authority is the domain (normaliseContent, validateSettings, …).
 */
export class TaskContentDto {
  @IsString()
  @MaxLength(TASK_TITLE_MAX * 4)
  title!: string;

  @IsString()
  @MaxLength(TASK_BODY_MAX * 4)
  body!: string;

  @IsIn(TASK_KINDS)
  kind!: string;

  @IsArray()
  @ArrayMaxSize(TASK_BUTTONS.length)
  @IsIn(TASK_BUTTONS, { each: true })
  buttons!: string[];

  @IsBoolean()
  reportRequired!: boolean;

  @IsIn(APPROVAL_MODES)
  approvalMode!: string;
}

export class PublishTaskDto extends TaskContentDto {
  @IsArray()
  @ArrayMaxSize(TASK_AUDIENCES.length)
  @IsIn(TASK_AUDIENCES, { each: true })
  audiences!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  communityId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  templateId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  clientRequestId?: string;
}

export class EditTaskDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision!: number;

  @IsOptional()
  @IsString()
  @MaxLength(TASK_TITLE_MAX * 4)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TASK_BODY_MAX * 4)
  body?: string;

  @IsOptional()
  @IsIn(TASK_KINDS)
  kind?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TASK_BUTTONS.length)
  @IsIn(TASK_BUTTONS, { each: true })
  buttons?: string[];

  @IsOptional()
  @IsBoolean()
  reportRequired?: boolean;

  @IsOptional()
  @IsIn(APPROVAL_MODES)
  approvalMode?: string;

  @IsOptional()
  @IsBoolean()
  requireReacknowledge?: boolean;
}

export class TrackTaskQuery {
  @IsOptional()
  @IsIn(ASSIGNMENT_FILTERS)
  filter?: (typeof ASSIGNMENT_FILTERS)[number];

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

export class PageQuery {
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

export class ReassignDto {
  @IsString()
  @MaxLength(ID_MAX)
  toUserId!: string;
}

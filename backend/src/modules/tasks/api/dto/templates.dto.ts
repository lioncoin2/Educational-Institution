import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import {
  APPROVAL_MODES,
  TASK_AUDIENCES,
  TASK_BODY_MAX,
  TASK_BUTTONS,
  TASK_KINDS,
  TASK_TITLE_MAX,
} from '../../application/views';
import { PublishTaskDto } from './tasks.dto';

const ID_MAX = 128;

/** Save a template from an existing task, or from a configuration typed here. */
export class SaveTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  fromTaskId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PublishTaskDto)
  draft?: PublishTaskDto;
}

/** Re-publish a past task; absent fields keep the earlier task's. */
export class RepublishTaskDto {
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
  @IsArray()
  @ArrayMaxSize(TASK_AUDIENCES.length)
  @IsIn(TASK_AUDIENCES, { each: true })
  audiences?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  communityId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  clientRequestId?: string;
}

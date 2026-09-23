import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { ENROLLMENT_OUTCOMES, SECTION_KINDS, TEACHING_ROLES } from '../../contracts/vocabulary';

/**
 * Transport shapes for /academic. They bound what a request may carry; the
 * domain decides what is valid and answers with precise codes
 * (academic.code_invalid, academic.name_invalid, …). Unknown fields are
 * refused outright — no request can smuggle in a status, a parent or an id
 * that the route does not name.
 */

const ID_MAX = 128;
const CODE_MAX = 200;
const NAME_MAX = 400;
const DESCRIPTION_MAX = 4000;

class Described {
  @IsString()
  @MaxLength(CODE_MAX)
  code!: string;

  @IsString()
  @MaxLength(NAME_MAX)
  name!: string;

  @IsInt()
  order!: number;
}

export class CreateSectionDto extends Described {
  @IsIn(SECTION_KINDS)
  kind!: string;

  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX)
  description?: string | null;
}

export class CreateProgramDto extends Described {
  @IsString()
  @MaxLength(ID_MAX)
  sectionId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX)
  description?: string | null;
}

export class CreateHalaqaDto extends Described {
  @IsString()
  @MaxLength(ID_MAX)
  programId!: string;
}

/** Only these fields ever change after creation; code, kind and parent never do. */
export class UpdateStructureDto {
  @IsOptional()
  @IsString()
  @MaxLength(NAME_MAX)
  name?: string;

  @IsOptional()
  @IsInt()
  order?: number;

  /** `null` clears it. */
  @ValidateIf((_dto, value) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(DESCRIPTION_MAX)
  description?: string | null;
}

export class UpdateHalaqaDto {
  @IsOptional()
  @IsString()
  @MaxLength(NAME_MAX)
  name?: string;

  @IsOptional()
  @IsInt()
  order?: number;
}

export class EnrollStudentDto {
  @IsString()
  @MaxLength(ID_MAX)
  studentUserId!: string;
}

export class EndEnrollmentDto {
  @IsIn(ENROLLMENT_OUTCOMES)
  outcome!: string;
}

export class AssignTeacherDto {
  @IsString()
  @MaxLength(ID_MAX)
  teacherUserId!: string;

  @IsIn(TEACHING_ROLES)
  role!: string;
}

export class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class StatusPageQuery extends PageQuery {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  status?: string;
}

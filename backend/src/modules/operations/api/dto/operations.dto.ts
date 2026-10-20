import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const ID_MAX = 128;
const DATE_MAX = 10; // YYYY-MM-DD
const TIME_MAX = 5; // HH:MM
const TZ_MAX = 64; // IANA zone id
const CURSOR_MAX = 512;
// Coarse transport guard; the authority is the domain's normaliseTitle /
// LESSON_TITLE_MAX (200). Kept equal by convention.
const TITLE_MAX = 200;

export class CreateLessonDto {
  @IsString()
  @MaxLength(ID_MAX)
  halaqaId!: string;

  @IsString()
  @MaxLength(DATE_MAX)
  date!: string;

  @IsString()
  @MaxLength(TIME_MAX)
  time!: string;

  @IsOptional()
  @IsString()
  @MaxLength(TZ_MAX)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TITLE_MAX)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  clientRequestId?: string;
}

export class UpdateLessonDto {
  @IsOptional()
  @IsString()
  @MaxLength(DATE_MAX)
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TIME_MAX)
  time?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TZ_MAX)
  timezone?: string;

  // @IsOptional() permits null as well as undefined: null clears the title.
  @IsOptional()
  @IsString()
  @MaxLength(TITLE_MAX)
  title?: string | null;
}

export class ListLessonsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  halaqaId?: string;

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

import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  DEVICE_PLATFORMS,
  NOTIFICATION_CATEGORIES,
  PUSH_PROVIDER_NAMES,
} from '../../contracts/vocabulary';

/**
 * Transport shapes for /notifications. They bound what a request may carry;
 * the use cases decide what is valid and answer with precise codes. Unknown
 * fields are rejected outright (see configureApp) — there is no field that
 * names an account: every route acts on the caller's own.
 */

const ID_MAX = 128;

export class ListNotificationsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class MarkAllReadDto {
  /**
   * The newest notification the person was looking at: it and everything
   * older is marked read, anything newer stays unread. Without it: everything
   * created until the request arrives.
   */
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  throughId?: string;
}

export class UpdatePreferencesDto {
  @IsIn(NOTIFICATION_CATEGORIES)
  category!: string;

  @IsOptional()
  @IsBoolean()
  inApp?: boolean;

  @IsOptional()
  @IsBoolean()
  realtime?: boolean;

  @IsOptional()
  @IsBoolean()
  push?: boolean;
}

export class RegisterDeviceDto {
  @IsIn(DEVICE_PLATFORMS)
  platform!: string;

  @IsIn(PUSH_PROVIDER_NAMES)
  provider!: string;

  /** The push provider's token for this installation. Never echoed back, never logged. */
  @IsString()
  @MinLength(32)
  @MaxLength(1024)
  token!: string;
}

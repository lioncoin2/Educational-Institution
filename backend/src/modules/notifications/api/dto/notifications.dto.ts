import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
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

/** 'HH:MM', 24-hour — the wire shape of a quiet-hours boundary. */
const TIME_OF_DAY = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const QUIET_HOURS_MODES = ['INHERIT', 'DISABLED', 'CUSTOM'] as const;

/**
 * The institution quiet-hours policy. The window and timezone are always
 * carried, even when disabled, so they are not lost when it is turned off.
 */
export class UpdateInstitutionSettingsDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  @Matches(TIME_OF_DAY, { message: 'start must be HH:MM, 24-hour' })
  start!: string;

  @IsString()
  @Matches(TIME_OF_DAY, { message: 'end must be HH:MM, 24-hour' })
  end!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  timezone!: string;
}

/**
 * A person's own settings. A PATCH: every field is optional and an absent one
 * is kept. `timezone: null` clears it; `quietHoursStart`/`End` are only for a
 * CUSTOM mode.
 */
export class UpdateUserNotificationSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string | null;

  @IsOptional()
  @IsIn(QUIET_HOURS_MODES)
  quietHoursMode?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_OF_DAY, { message: 'quietHoursStart must be HH:MM, 24-hour' })
  quietHoursStart?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_OF_DAY, { message: 'quietHoursEnd must be HH:MM, 24-hour' })
  quietHoursEnd?: string;
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

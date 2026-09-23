import { Type } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

import {
  DEVICE_PLATFORMS,
  IDENTIFIER_KINDS,
  type DevicePlatform,
  type IdentifierKind,
} from '../../application/input-vocabulary';

/**
 * Transport contracts for /auth. Deliberately separate from the domain: these
 * describe what a request may carry, and are validated before any use case
 * runs. Unknown fields are rejected outright (see configureApp).
 *
 * Password fields are bounded but NOT policy-checked here. On login that is
 * deliberate — an old password must keep working, and "too short" would
 * confirm the policy to a guesser. On change, the domain applies the policy and
 * returns a precise error.
 */

export class DeviceDto {
  @IsOptional()
  @IsIn(DEVICE_PLATFORMS)
  platform?: DevicePlatform;

  /** Cleaned and cut to 64 characters by the domain before it is stored. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  appVersion?: string;
}

export class LoginDto {
  /** Defaults to "email", the only kind today. */
  @IsOptional()
  @IsIn(IDENTIFIER_KINDS)
  identifierType?: IdentifierKind;

  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  identifier!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  password!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceDto)
  device?: DeviceDto;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  refreshToken!: string;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  currentPassword!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  newPassword!: string;
}

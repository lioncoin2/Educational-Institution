import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  ALL_ACCOUNT_STATUSES,
  IDENTIFIER_KINDS,
  ROLE_CODE_SHAPE,
  type AccountStatus,
  type IdentifierKind,
} from '../../application/input-vocabulary';

/** Transport contracts for /admin/users — account provisioning by staff. */

export class CreateUserDto {
  /** Trimmed and length-checked (1–120) by the domain. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  displayName!: string;

  @IsOptional()
  @IsIn(IDENTIFIER_KINDS)
  identifierType?: IdentifierKind;

  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  identifier!: string;

  /** Policy-checked by the domain; bounded here only against abuse. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  initialPassword!: string;
}

export class AssignRoleDto {
  @IsString()
  @Matches(ROLE_CODE_SHAPE, { message: 'role must be an upper-case role code, e.g. TEACHER' })
  role!: string;
}

export class ChangeStatusDto {
  @IsIn(ALL_ACCOUNT_STATUSES)
  status!: AccountStatus;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  newPassword!: string;
}

export class ListUsersQuery {
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

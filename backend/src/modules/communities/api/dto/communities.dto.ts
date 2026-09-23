import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { MAX_MEMBERS_PER_ADD } from '../../application/communities-settings';

/**
 * Transport shapes for /communities. They bound what a request may carry;
 * the domain decides what is valid and answers with precise codes
 * (communities.title_invalid, communities.invitation_terms_invalid, …).
 * Unknown fields are refused (400) by the global pipe, so no request can
 * smuggle in a community id, a status, a standing or a capability the route
 * does not name.
 */

const ID_MAX = 128;

export class PageQuery {
  /** Clamped to the list's maximum by the use case — never refused for its size. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  /** Opaque; one this API did not issue is 422 `communities.cursor_invalid`. */
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class ListCommunitiesQuery extends PageQuery {
  @IsOptional()
  @IsIn(['mine', 'all'])
  scope?: 'mine' | 'all';
}

export class CreateCommunityDto {
  /** The domain holds a title to 1–100 characters: anything else is 422 `communities.title_invalid`. */
  @IsString()
  title!: string;
}

export class AddMembersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MEMBERS_PER_ADD)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(ID_MAX, { each: true })
  userIds!: string[];
}

export class CreateInvitationDto {
  @IsOptional()
  @IsInt()
  expiresInSeconds?: number;

  /** Absent or null: no use limit. */
  @ValidateIf((_dto, value) => value !== null && value !== undefined)
  @IsInt()
  maxUses?: number | null;
}

/**
 * The token travels in the body, under the key `token` only — which the
 * logger redacts — never in a path or a query string (which are logged, and
 * which link scanners prefetch). It is not validated here at all: a missing,
 * malformed or unknown token is answered alike, 404
 * `communities.invitation_invalid` (§7.2), by the use case's shape check.
 */
export class RedeemInvitationDto {
  @Allow()
  token?: unknown;
}

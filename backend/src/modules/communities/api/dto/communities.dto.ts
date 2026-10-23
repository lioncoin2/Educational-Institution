import { Transform, Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

import { MAX_MEMBERS_PER_ADD } from '../../application/communities-settings';
import { COMMUNITY_CAPABILITIES, type CommunityCapability } from '../../contracts/capabilities';
import { COMMUNITY_KINDS, type CommunityKind } from '../../contracts/vocabulary';

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

/**
 * `GET /communities/:id/member-candidates?q=&limit=&cursor=` — the community
 * add-member picker's search. `q` is the required display-name prefix (trimmed,
 * non-empty, at most 100 chars), the same shape `GET /people` uses; `limit` is
 * clamped by identity, `cursor` is the opaque keyset cursor. The caller's right
 * to search is `community.members.invite` IN this community, decided in the use
 * case — never asserted by the client.
 */
export class MemberCandidatesQuery extends PageQuery {
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(100)
  q!: string;
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

  /**
   * GROUP (open member posting) or CHANNEL (publishers only), ADR 0039.
   * Optional for older clients and defaults to GROUP; any other value is 400.
   * The product kind is the only mode input a client may supply — it can never
   * set an arbitrary chat mode, standing, or capability.
   */
  @IsOptional()
  @IsIn(COMMUNITY_KINDS)
  kind?: CommunityKind;
}

/** `PUT /communities/:id/chat-mode` — restrict or restore a group's member posting (ADR 0039). */
export class SetChatModeDto {
  @IsBoolean()
  membersMayPost!: boolean;
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

/**
 * A grant list's filters. A capability outside the vocabulary is refused
 * here (400); `userId` narrows the owner's view, and for anyone else can
 * only name themself.
 */
export class ListGrantsQuery extends PageQuery {
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  userId?: string;

  @IsOptional()
  @IsIn([...COMMUNITY_CAPABILITIES])
  capability?: CommunityCapability;
}

/** One member, one to seven distinct capabilities of the vocabulary — or 400. */
export class GrantCapabilitiesDto {
  @IsString()
  @MaxLength(ID_MAX)
  userId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(COMMUNITY_CAPABILITIES.length)
  @ArrayUnique()
  @IsIn([...COMMUNITY_CAPABILITIES], { each: true })
  capabilities!: CommunityCapability[];
}

export class TransferOwnershipDto {
  @IsString()
  @MaxLength(ID_MAX)
  userId!: string;
}

/**
 * `POST /communities/:id/halaqat` — add an academic halaqa association to this
 * community (Q50). A non-empty opaque id; existence is validated server-side
 * through academic's contract, and the link is inert metadata. A group or
 * channel may be associated with many halaqat; linking the same one twice is a
 * no-op. Removing an association is `DELETE /communities/:id/halaqat/:halaqaId`,
 * which carries no body.
 */
export class LinkHalaqaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX)
  halaqaId!: string;
}

/**
 * `PUT /communities/:id/profile` — a full replace of the community's own title,
 * description and picture together. `title` is required; `description` and
 * `avatarFileAssetId` may be null (cleared) or omitted (treated as null). These
 * bounds are generous transport limits; the domain decides what is valid
 * (communities.title_invalid, communities.description_invalid) and Files decides
 * whether the picture is an image the editor owns.
 */
export class EditCommunityProfileDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @ValidateIf((dto: EditCommunityProfileDto) => dto.description !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @ValidateIf((dto: EditCommunityProfileDto) => dto.avatarFileAssetId !== null)
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX)
  avatarFileAssetId?: string | null;
}

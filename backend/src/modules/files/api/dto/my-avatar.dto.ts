import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * "Use this already-uploaded image as my picture." Shape only: that the asset
 * is an image the caller owns is Files' own check, which answers with its
 * precise codes (files.asset_not_found, files.asset_kind_not_accepted, …).
 */
export class SetMyAvatarDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileAssetId!: string;
}

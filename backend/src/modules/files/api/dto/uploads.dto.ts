import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

import { FILE_KINDS, type FileKind } from '../../contracts/file-kind';

/**
 * "I am about to upload this." Shape only: the upload policy — allowed types,
 * extensions, size and metadata bounds — is the domain's, and answers with
 * precise error codes (files.too_large, files.extension_mismatch, …).
 */
export class RequestUploadDto {
  @IsIn(FILE_KINDS)
  kind!: FileKind;

  @IsString()
  @MaxLength(255)
  contentType!: string;

  /** Exact size in bytes; the stored object must match it. */
  @IsInt()
  byteSize!: number;

  /** Shown to people, never used as a path; sanitized by the domain. */
  @IsString()
  @MaxLength(1024)
  fileName!: string;

  /** Voice and audio only. */
  @IsOptional()
  @IsInt()
  durationMs?: number | null;

  /** Images only, both or neither. */
  @IsOptional()
  @IsInt()
  width?: number | null;

  @IsOptional()
  @IsInt()
  height?: number | null;
}

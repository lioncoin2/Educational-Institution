import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';

import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import type { Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import { CompleteUploadUseCase } from '../application/complete-upload.use-case';
import { RequestUploadUseCase } from '../application/request-upload.use-case';
import { RequestUploadDto } from './dto/uploads.dto';
import {
  toFileAssetResponse,
  toUploadTicketResponse,
  type FileAssetResponse,
  type UploadTicketResponse,
} from './responses';

/**
 * Uploading is two calls around one transfer:
 *
 *   1. POST /files/uploads                 declare it → a signed PUT URL
 *   2. PUT  <url>                          the bytes, straight to storage
 *   3. POST /files/uploads/:id/complete    verify it → an attachable asset
 *
 * There is no download route here on purpose. Whether someone may read a file
 * depends on what the file is attached to, which only the attaching module
 * knows — messaging hands out attachment links after its own checks.
 */
@Controller('files/uploads')
export class UploadsController {
  constructor(
    private readonly requestUpload: RequestUploadUseCase,
    private readonly completeUpload: CompleteUploadUseCase,
  ) {}

  @Post()
  @RequirePermission(Permissions.files.upload)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: RequestUploadDto,
  ): Promise<UploadTicketResponse> {
    const ticket = unwrap(
      await this.requestUpload.execute({
        principal,
        declaration: {
          kind: dto.kind,
          contentType: dto.contentType,
          byteSize: dto.byteSize,
          fileName: dto.fileName,
          durationMs: dto.durationMs ?? null,
          width: dto.width ?? null,
          height: dto.height ?? null,
        },
      }),
    );
    return toUploadTicketResponse(ticket);
  }

  @Post(':assetId/complete')
  @RequirePermission(Permissions.files.upload)
  @HttpCode(HttpStatus.OK)
  async complete(
    @CurrentPrincipal() principal: Principal,
    @Param('assetId') assetId: string,
  ): Promise<FileAssetResponse> {
    return toFileAssetResponse(unwrap(await this.completeUpload.execute({ principal, assetId })));
  }
}

import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';

import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import type { Principal } from '../../../shared';
import { Authenticated } from '../../identity/contracts/route-access';
import { ClearMyAvatarUseCase, SetMyAvatarUseCase } from '../application/my-avatar.use-cases';
import { GetMyAssetLinkUseCase } from '../application/my-asset-link.use-case';
import { SetMyAvatarDto } from './dto/my-avatar.dto';
import {
  toDownloadLinkResponse,
  toFileAssetResponse,
  type DownloadLinkResponse,
  type FileAssetResponse,
} from './responses';

/**
 * The caller's own files: their profile picture, and links to objects they
 * uploaded.
 *
 * Every route is `@Authenticated()` and scoped to the caller's own id — there
 * is no other account's picture to set here, and the link route serves only an
 * asset the caller owns. Setting an avatar does not re-use the upload
 * permission: the bytes were already uploaded through `POST /files/uploads`;
 * this only points the account at one of them, after Files has verified it is
 * an image the caller owns.
 */
@Controller('files/me')
export class MyFilesController {
  constructor(
    private readonly setAvatar: SetMyAvatarUseCase,
    private readonly clearAvatar: ClearMyAvatarUseCase,
    private readonly assetLink: GetMyAssetLinkUseCase,
  ) {}

  @Put('avatar')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async avatar(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: SetMyAvatarDto,
  ): Promise<FileAssetResponse> {
    return toFileAssetResponse(
      unwrap(await this.setAvatar.execute({ principal, fileAssetId: dto.fileAssetId })),
    );
  }

  @Delete('avatar')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAvatar(@CurrentPrincipal() principal: Principal): Promise<void> {
    unwrap(await this.clearAvatar.execute({ principal }));
  }

  @Post('assets/:assetId/link')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async link(
    @CurrentPrincipal() principal: Principal,
    @Param('assetId') assetId: string,
  ): Promise<DownloadLinkResponse> {
    return toDownloadLinkResponse(unwrap(await this.assetLink.execute({ principal, assetId })));
  }
}

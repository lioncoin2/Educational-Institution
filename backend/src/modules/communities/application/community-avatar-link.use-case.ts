import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type CallMetadata, type Principal, type Result } from '../../../shared';
import { FILE_ASSETS, type DownloadLink, type FileAssets } from '../../files/contracts/file-assets';
import { ruleFor } from '../domain/act-rules';
import { CommunityAuthorizationService } from './community-authorization.service';

const NO_AVATAR = failure('not_found', 'communities.avatar_not_found', 'No community picture.');

/**
 * A short-lived link to a community's picture.
 *
 * Whoever may see the community (`community.view`, member or overseer) may see
 * its picture; the decision is Communities', asked through the one evaluator.
 * The stored reference was verified as an image when it was set
 * (`community.profile.edit`), so serving it needs no ownership check — unlike a
 * person's own avatar, a community's picture is owned by whoever uploaded it,
 * not by the viewer. No picture reads as "no community picture".
 */
@Injectable()
export class GetCommunityAvatarLinkUseCase {
  constructor(
    private readonly authorization: CommunityAuthorizationService,
    @Inject(FILE_ASSETS) private readonly files: FileAssets,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly communityId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<DownloadLink>> {
    const { result, read } = await this.authorization.evaluate(
      command.principal,
      command.communityId,
      ruleFor('community.view'),
    );
    if (!result.ok) return result;

    const avatarFileAssetId = read?.community?.avatarFileAssetId ?? null;
    if (avatarFileAssetId === null) return err(NO_AVATAR);

    const link = await this.files.createDownloadLink(avatarFileAssetId);
    return link.ok ? ok(link.value) : err(NO_AVATAR);
  }
}

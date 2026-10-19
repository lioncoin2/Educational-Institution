import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Principal, type Result } from '../../../shared';
import { FILE_ASSETS, type DownloadLink, type FileAssets } from '../../files/contracts/file-assets';
import type { FileKind } from '../../files/contracts/file-kind';
import {
  ACCOUNT_DIRECTORY,
  type AccountDirectory,
} from '../../identity/contracts/account-directory';
import {
  AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import { Permissions } from '../../identity/contracts/permissions';

const NO_AVATAR = failure('not_found', 'people.person_avatar_not_found', 'No profile picture.');
const AVATAR_KINDS: readonly FileKind[] = ['IMAGE'];

/**
 * A short-lived link to a person's profile picture, for a caller who may read
 * the people directory (`people.read`; OWNER/ADMIN since migration 0020).
 *
 * The right is re-asked here, never assumed from the HTTP guard — a use case may
 * be reached by a job or an event handler that passed no guard, exactly as the
 * search itself re-asks. The picture is resolved the same way the directory
 * resolves the name — by account id — then Files verifies the asset is still an
 * image that person owns before minting the link, so a reference the person has
 * since cleared or replaced cannot leak. An unknown account, or one with no
 * picture, reads as "no profile picture" (a 404 all the same, so an authorized
 * caller learns nothing about which ids exist beyond what the search already
 * told them, and an unauthorized caller is refused before any id is read).
 */
@Injectable()
export class GetPersonAvatarLinkUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly authorization: AuthorizationService,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    @Inject(FILE_ASSETS) private readonly files: FileAssets,
  ) {}

  async execute(query: {
    readonly principal: Principal;
    readonly userId: string;
  }): Promise<Result<DownloadLink>> {
    const allowed = this.authorization.authorize(query.principal, Permissions.people.read);
    if (!allowed.ok) return allowed;

    const [person] = await this.directory.describe([query.userId]);
    if (person === undefined || person.avatarFileAssetId === null) return err(NO_AVATAR);

    // The reference is only turned into a link once Files confirms it is still
    // an image that person owns — so a stale or swapped reference cannot leak.
    const verified = await this.files.verifyAttachable(
      person.avatarFileAssetId,
      query.userId,
      AVATAR_KINDS,
    );
    if (!verified.ok) return err(NO_AVATAR);

    const link = await this.files.createDownloadLink(person.avatarFileAssetId);
    return link.ok ? ok(link.value) : err(NO_AVATAR);
  }
}

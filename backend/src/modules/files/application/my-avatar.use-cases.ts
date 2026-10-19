import { Inject, Injectable } from '@nestjs/common';

import { ok, type Principal, type Result } from '../../../shared';
import {
  ACCOUNT_AVATAR_WRITER,
  type AccountAvatarWriter,
} from '../../identity/contracts/account-avatar';
import { FILE_ASSETS, type FileAssets, type FileAssetSummary } from '../contracts/file-assets';
import type { FileKind } from '../contracts/file-kind';

/** A profile picture is always an image. */
const AVATAR_KINDS: readonly FileKind[] = ['IMAGE'];

/**
 * Set the caller's own profile picture.
 *
 * Files owns the check identity cannot run (the dependency is files → identity):
 * the asset must be an AVAILABLE image the caller uploaded. Only once it is
 * verified does Files hand the reference to identity's avatar writer, which is
 * the one module that mutates `users`. Setting it to an asset the caller does
 * not own reads as "no such file", exactly as attaching one does.
 */
@Injectable()
export class SetMyAvatarUseCase {
  constructor(
    @Inject(FILE_ASSETS) private readonly files: FileAssets,
    @Inject(ACCOUNT_AVATAR_WRITER) private readonly avatars: AccountAvatarWriter,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly fileAssetId: string;
  }): Promise<Result<FileAssetSummary>> {
    const verified = await this.files.verifyAttachable(
      command.fileAssetId,
      command.principal.userId,
      AVATAR_KINDS,
    );
    if (!verified.ok) return verified;

    const stored = await this.avatars.setAvatar(command.principal.userId, command.fileAssetId);
    if (!stored.ok) return stored;
    return ok(verified.value);
  }
}

/** Remove the caller's own profile picture, restoring the default (initials) view. */
@Injectable()
export class ClearMyAvatarUseCase {
  constructor(@Inject(ACCOUNT_AVATAR_WRITER) private readonly avatars: AccountAvatarWriter) {}

  async execute(command: { readonly principal: Principal }): Promise<Result<void>> {
    return this.avatars.clearAvatar(command.principal.userId);
  }
}

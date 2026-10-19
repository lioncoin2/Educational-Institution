import type { Result } from '../../../shared';

/** DI token. */
export const ACCOUNT_AVATAR_WRITER = Symbol('ACCOUNT_AVATAR_WRITER');

/**
 * Lets another module record which Files asset is an account's profile picture,
 * without that module writing identity's tables.
 *
 * The dependency runs files → identity (Files authorizes uploads with identity's
 * authority), so identity cannot ask Files "is this an image this account owns?"
 * — that would be a cycle. Instead Files, which already holds that check
 * (`verifyAttachable`), performs it and then calls this writer with a reference
 * it has already verified. Identity stays the only module that mutates `users`
 * and owns the invariant that the stored value is a reference or null; Files
 * owns the invariant that the reference is an image the account owns.
 *
 * `userId` is always the authenticated caller's own id: an account sets only its
 * own picture, so there is no third party to authorize here.
 */
export interface AccountAvatarWriter {
  /** Records `fileAssetId` (already verified) as `userId`'s picture. */
  setAvatar(userId: string, fileAssetId: string): Promise<Result<void>>;

  /** Removes `userId`'s picture, restoring the default view. */
  clearAvatar(userId: string): Promise<Result<void>>;
}

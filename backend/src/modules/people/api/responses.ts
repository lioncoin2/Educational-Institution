import type { Page } from '../../../shared';
import type { DownloadLink } from '../../files/contracts/file-assets';
import type { AccountSummary } from '../../identity/contracts';

/**
 * One match on the people search — the whole of what the wire discloses: an id
 * to act on (add, message), a name to show, and a reference to the person's
 * picture (a Files asset id, or null — never a URL and never the bytes; the
 * client turns it into a short-lived link through `GET /people/:userId/avatar`,
 * re-authorized there). Never an email, a role or any security state. This is
 * the privacy boundary: identity's richer record (`UserAccountView` with login
 * identifiers) is never reused here.
 */
export interface PersonSearchResult {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarFileAssetId: string | null;
}

interface PageResponse<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export function toPeopleSearchResponse(
  page: Page<AccountSummary>,
): PageResponse<PersonSearchResult> {
  return {
    items: page.items.map((account) => ({
      userId: account.userId,
      displayName: account.displayName,
      avatarFileAssetId: account.avatarFileAssetId,
    })),
    nextCursor: page.nextCursor ?? null,
  };
}

/** A short-lived link to a person's picture; `expiresAt` is ISO 8601. */
export interface PersonAvatarLinkResponse {
  readonly url: string;
  readonly expiresAt: string;
}

export function toPersonAvatarLinkResponse(link: DownloadLink): PersonAvatarLinkResponse {
  return { url: link.url, expiresAt: link.expiresAt.toISOString() };
}

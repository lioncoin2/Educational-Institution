import type { Page } from '../../../shared';
import type { AccountSummary } from '../../identity/contracts';

/**
 * One match on the people search — the whole of what the wire discloses: an id
 * to act on (add, message) and a name to show. Never an email, a role or any
 * security state. This is the privacy boundary: identity's richer record
 * (`UserAccountView` with login identifiers) is never reused here.
 */
export interface PersonSearchResult {
  readonly userId: string;
  readonly displayName: string;
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
    })),
    nextCursor: page.nextCursor ?? null,
  };
}

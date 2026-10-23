import type { CommunityKind } from './vocabulary';

/** DI token. */
export const COMMUNITY_DIRECTORY = Symbol('COMMUNITY_DIRECTORY');

export interface CommunitySummary {
  readonly communityId: string;
  readonly title: string;
  /**
   * The community's product kind (ADR 0039) — GROUP or CHANNEL — for display.
   * Derived from the chat mode (a restricted group is still a GROUP); it never
   * decides access, exactly as `title` does not.
   */
  readonly kind: CommunityKind;
}

/**
 * A community's title, for display — shown after a positive permit, never
 * instead of one. It answers nothing about access. Unknown ids are absent.
 */
export interface CommunityDirectory {
  /** At most 1,000 ids. */
  describe(communityIds: readonly string[]): Promise<readonly CommunitySummary[]>;
}

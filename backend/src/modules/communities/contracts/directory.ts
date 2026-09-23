/** DI token. */
export const COMMUNITY_DIRECTORY = Symbol('COMMUNITY_DIRECTORY');

export interface CommunitySummary {
  readonly communityId: string;
  readonly title: string;
}

/**
 * A community's title, for display — shown after a positive permit, never
 * instead of one. It answers nothing about access. Unknown ids are absent.
 */
export interface CommunityDirectory {
  /** At most 1,000 ids. */
  describe(communityIds: readonly string[]): Promise<readonly CommunitySummary[]>;
}

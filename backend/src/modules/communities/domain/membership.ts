import type {
  MembershipSource,
  MembershipStanding,
  MembershipStatus,
} from '../contracts/vocabulary';

/**
 * One stay of one account in one community (§3.2): ACTIVE, then LEFT or
 * REMOVED, and terminal — a rejoin is a new stint with a new id. History is
 * kept: nothing is overwritten, so who added someone, and when they left,
 * survive a rejoin.
 *
 * `userId` is identity's id and never a foreign key. `version` is the
 * community-wide version of this row's latest change: unique per community,
 * in commit order, and only ever raised — so "latest stint" always means the
 * highest version, never the latest `joinedAt` (a clock can step back).
 */
export interface Stint {
  readonly id: string;
  readonly communityId: string;
  readonly userId: string;
  readonly status: MembershipStatus;
  readonly standing: MembershipStanding;
  readonly source: MembershipSource;
  /** Null for a self-join through a link. */
  readonly addedBy: string | null;
  /** Set exactly when the source is INVITATION. */
  readonly invitationId: string | null;
  readonly joinedAt: Date;
  /** Null exactly while ACTIVE; never before `joinedAt`. */
  readonly endedAt: Date | null;
  /** The person themself for LEFT; whoever removed them for REMOVED. */
  readonly endedBy: string | null;
  readonly version: number;
}

export function isActive(stint: Stint): boolean {
  return stint.status === 'ACTIVE';
}

/** The creator's stint: the owner, and the community's first membership change. */
export function ownerStint(input: {
  readonly id: string;
  readonly communityId: string;
  readonly userId: string;
  readonly at: Date;
}): Stint {
  return {
    id: input.id,
    communityId: input.communityId,
    userId: input.userId,
    status: 'ACTIVE',
    standing: 'OWNER',
    source: 'ADDED',
    addedBy: input.userId,
    invitationId: null,
    joinedAt: input.at,
    endedAt: null,
    endedBy: null,
    version: 1,
  };
}

/** A stint a manager started, or one a link started — with the version allocated for it. */
export function memberStint(input: {
  readonly id: string;
  readonly communityId: string;
  readonly userId: string;
  readonly source: MembershipSource;
  readonly addedBy: string | null;
  readonly invitationId: string | null;
  readonly at: Date;
  readonly version: number;
}): Stint {
  return {
    id: input.id,
    communityId: input.communityId,
    userId: input.userId,
    status: 'ACTIVE',
    standing: 'MEMBER',
    source: input.source,
    addedBy: input.source === 'ADDED' ? input.addedBy : null,
    invitationId: input.source === 'INVITATION' ? input.invitationId : null,
    joinedAt: input.at,
    endedAt: null,
    endedBy: null,
    version: input.version,
  };
}

/**
 * The stint ended — the person left (LEFT, by themself) or was removed. The
 * end is never recorded before the start: a clock that stepped back is held
 * to `joinedAt`, as the database's `greatest(…)` does.
 */
export function endStint(
  stint: Stint,
  ending: {
    readonly status: 'LEFT' | 'REMOVED';
    readonly by: string | null;
    readonly at: Date;
    readonly version: number;
  },
): Stint {
  const at = ending.at.getTime() < stint.joinedAt.getTime() ? stint.joinedAt : ending.at;
  return {
    ...stint,
    status: ending.status,
    endedAt: at,
    endedBy: ending.status === 'LEFT' ? stint.userId : ending.by,
    version: ending.version,
  };
}

/**
 * Of several stints of one person in one community, the latest — by version,
 * never by `joinedAt`.
 */
export function latestStint(stints: readonly Stint[]): Stint | null {
  let latest: Stint | null = null;
  for (const stint of stints) if (latest === null || stint.version > latest.version) latest = stint;
  return latest;
}

import type { CommunityStatus } from '../contracts/vocabulary';

/**
 * A community: a persistent space that lasts months or years — never a live
 * room and never derived from one.
 *
 * The root is small and never holds its members. There is no owner column
 * (ownership is standing on a stint), no kind (a kind would pre-answer Q36)
 * and no halaqa link (Q50). A community is never deleted (Q47).
 *
 * `status` is typed as the known vocabulary, but a row written by a later
 * build may carry a status this one does not know; `lifecycle.ts` gives such
 * a status its own, most careful, reading.
 */
export interface Community {
  readonly id: string;
  readonly title: string;
  readonly status: CommunityStatus;
  /** ≥ 1; +1 on every real status change. */
  readonly lifecycleVersion: number;
  /** ≥ 0; the last version allocated to a membership change. */
  readonly membershipVersion: number;
  /** ACTIVE stints, kept in the same transaction as every stint start and end. No upper bound. */
  readonly memberCount: number;
  /** Always a person in v1; nullable only for symmetry with the journals. */
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly statusChangedAt: Date | null;
  readonly statusChangedBy: string | null;
  readonly updatedAt: Date;
}

/**
 * A new community, as its creation transaction writes it: OPEN, with its
 * creator as owner and first member — so one member, and one allocated
 * membership version (the owner's stint's).
 */
export function newCommunity(input: {
  readonly id: string;
  readonly title: string;
  readonly createdBy: string;
  readonly at: Date;
}): Community {
  return {
    id: input.id,
    title: input.title,
    status: 'OPEN',
    lifecycleVersion: 1,
    membershipVersion: 1,
    memberCount: 1,
    createdBy: input.createdBy,
    createdAt: input.at,
    statusChangedAt: null,
    statusChangedBy: null,
    updatedAt: input.at,
  };
}

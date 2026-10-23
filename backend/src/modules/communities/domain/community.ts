import { err, failure, ok, type Result } from '../../../shared/result';
import type { CommunityChatMode, CommunityStatus } from '../contracts/vocabulary';

/**
 * A community: a persistent space that lasts months or years — never a live
 * room and never derived from one.
 *
 * The root is small and never holds its members. There is no owner column
 * (ownership is standing on a stint). It carries a `chatMode` (ADR 0039 —
 * GROUP_OPEN / GROUP_RESTRICTED / CHANNEL): the product kind (group vs channel)
 * and, for a group, whether ordinary members may post. The mode is a label and
 * a policy input, never the authorization itself — `COMMUNITY_AUTHORIZATION`
 * decides posting from it on every send. It MAY be associated with academic
 * halaqat (Q50) — a many-to-many link held in `community_halaqa_links`, not on
 * this root: inert metadata, set and cleared by institutional oversight,
 * deriving no membership, capability or authorization. A community is never
 * deleted (Q47).
 *
 * `status` and `chatMode` are typed as the known vocabulary, but a row written
 * by a later build may carry a value this one does not know; the consuming code
 * gives such a value its own, most careful, reading.
 */
export interface Community {
  readonly id: string;
  readonly title: string;
  /** A short description shown with the community, or null when unset. */
  readonly description: string | null;
  /**
   * A Files asset id (the community's picture), or null. A reference, never a
   * URL: the row it points at belongs to the files module, and a viewer turns
   * it into a short-lived link through Communities' own authorized route.
   */
  readonly avatarFileAssetId: string | null;
  /** The chat posting mode (ADR 0039): group open/restricted, or channel. */
  readonly chatMode: CommunityChatMode;
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
  readonly chatMode: CommunityChatMode;
  readonly createdBy: string;
  readonly at: Date;
}): Community {
  return {
    id: input.id,
    title: input.title,
    description: null,
    avatarFileAssetId: null,
    chatMode: input.chatMode,
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

/**
 * Restrict or restore a GROUP's member posting (ADR 0039):
 * `GROUP_OPEN ↔ GROUP_RESTRICTED` only. A CHANNEL's publishing is fixed and
 * cannot be opened to members, and a group cannot be turned into a channel
 * here (product kind is immutable). Setting the mode it already has is a no-op
 * that still bumps `updatedAt`, so the write stays idempotent.
 */
export function setChatMode(
  community: Community,
  to: CommunityChatMode,
  at: Date,
): Result<Community> {
  if (community.chatMode === 'CHANNEL' || to === 'CHANNEL') {
    return err(
      failure(
        'conflict',
        'communities.chat_mode_transition_invalid',
        'Only a group can switch between open and restricted member posting.',
        { from: community.chatMode, to },
      ),
    );
  }
  return ok({ ...community, chatMode: to, updatedAt: at });
}

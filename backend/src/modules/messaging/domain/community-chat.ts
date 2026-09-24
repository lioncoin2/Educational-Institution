import type { Conversation, ConversationId } from './conversation';
import type { Participant } from './participant';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  COMMUNITY CHATS — PROVISIONAL (Q51, Q52, Q53)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A community's chat is an ordinary CHANNEL conversation linked to the
 * community by `communityId` (docs/architecture/community-chat.md §5).
 * Communities decides who belongs and who may read or post; messaging stores
 * and delivers the messages, exactly as for every other conversation.
 *
 * Messaging's participant rows for such a chat are a NAMED PROJECTION of
 * Communities' ACTIVE members (§6): derived, versioned from the authority,
 * written only by the projection applier, and never an access answer on
 * their own — every request still asks Communities. Each row is a
 * last-writer-wins register keyed by the authority's version, which
 * `projectMember` below defines once for both adapters.
 *
 * This file imports nothing from Communities: the application maps
 * Communities' `MemberState` onto `CommunityMemberState`.
 */

/** One account's latest stint in the community, as the authority reports it. */
export interface CommunityMemberState {
  readonly userId: string;
  /** The stint's id: a rejoin is a new stint, so a new id. */
  readonly membershipId: string;
  readonly active: boolean;
  /** Provenance only: never compared, so a clock step cannot fake a rejoin. */
  readonly joinedAt: Date;
  /** > 0, unique per community, in commit order. */
  readonly version: number;
}

export type CommunityHistory = 'FULL' | 'FROM_JOIN';

/**
 * Where a newcomer's view of a community chat starts (Q52). PROVISIONAL
 * 'FULL': the whole history, as a channel shows it (Q21's notice-board rule).
 * 'FROM_JOIN' would hide everything sent before the join was applied.
 * Windows are stored per row, so changing this changes future joins only.
 */
export const COMMUNITY_HISTORY: CommunityHistory = 'FULL';

/**
 * `created_by` of every community chat: a label, never a principal. It is
 * never passed to authorization, never exposed, and authorizes nothing.
 */
export const COMMUNITY_CHAT_CREATOR = 'system:messaging-community-chat';

/**
 * The most member states one apply takes — Communities' page size. One batch
 * is also the longest a send waits for the conversation lock (§6.3).
 */
export const MAX_APPLY_BATCH = 1000;

export function isCommunityChat(conversation: Pick<Conversation, 'communityId'>): boolean {
  return conversation.communityId !== null;
}

/**
 * A community's chat before anyone is projected into it: stored as CHANNEL
 * (PROVISIONAL, Q51), untitled (the title is Communities', read when viewed),
 * with no members and nothing projected yet.
 */
export function newCommunityChat(input: {
  readonly id: ConversationId;
  readonly communityId: string;
  readonly at: Date;
}): Conversation {
  return {
    id: input.id,
    type: 'CHANNEL',
    title: null,
    createdBy: COMMUNITY_CHAT_CREATOR,
    createdAt: input.at,
    directPair: null,
    lastSequence: 0,
    lastMessageAt: null,
    memberCount: 0,
    communityId: input.communityId,
    projectedMembershipVersion: 0,
  };
}

export type ProjectionTransition =
  'joined' | 'rejoined' | 'left' | 'tombstoned' | 'bumped' | 'ignored';

export interface ProjectedMember {
  /** The row to store; unchanged (or null, when absent) exactly when ignored. */
  readonly next: Participant | null;
  readonly transition: ProjectionTransition;
  /** The change to the conversation's current-member count. */
  readonly delta: -1 | 0 | 1;
}

/**
 * The projection register (§6.2): what one member's row becomes when the
 * authority reports `state`. Every transition needs a version newer than
 * the row's; anything else is `ignored`, so a replay changes nothing, the
 * highest version wins whatever order states arrive in, and concurrent
 * appliers converge.
 *
 *   row      incoming          transition   Δ   written
 *   absent   ACTIVE            joined       +1  MEMBER, joined now, watermark at the
 *                                                last sequence, window per history
 *   absent   LEFT              tombstoned    0  joined = left = now, 0/0 — a version
 *                                                that an older ACTIVE can never beat
 *   ACTIVE   ACTIVE, same m    bumped        0  the source only
 *   ACTIVE   ACTIVE, new m′    rejoined      0  a missed leave: watermark and window reset
 *   ACTIVE   LEFT              left         −1  left = greatest(now, joined)
 *   LEFT     ACTIVE            rejoined     +1  as joined
 *   LEFT     LEFT              bumped        0  the source only
 *   any      version ≤ row's   ignored       0  nothing
 *
 * A rejoin is told by the stint id alone — LEFT to ACTIVE, or an ACTIVE whose
 * id differs from the row's — never by comparing times.
 *
 * `override` is the reconciler's alone (§7.5): after the authority was
 * restored behind the projection, it writes the authority's state whatever
 * the row's version, lowering it if need be.
 */
export function projectMember(
  row: Participant | null,
  state: CommunityMemberState,
  conversation: Pick<Conversation, 'id' | 'lastSequence'>,
  at: Date,
  options: { readonly override?: boolean; readonly history?: CommunityHistory } = {},
): ProjectedMember {
  if (row !== null && (row.userId !== state.userId || row.conversationId !== conversation.id)) {
    throw new RangeError('A member state applies to its own row only.');
  }
  if (!Number.isSafeInteger(state.version) || state.version < 1) {
    throw new RangeError('A membership version is a whole number from 1.');
  }
  const ignored: ProjectedMember = { next: row, transition: 'ignored', delta: 0 };
  if (options.override === true) {
    if (row !== null && reflects(row, state)) return ignored;
  } else if (row !== null && state.version <= (row.sourceVersion ?? 0)) {
    return ignored;
  }

  const source = {
    sourceVersion: state.version,
    sourceMembershipId: state.membershipId,
    sourceJoinedAt: state.joinedAt,
  };
  const history = options.history ?? COMMUNITY_HISTORY;
  const joining = (): Participant => ({
    conversationId: conversation.id,
    userId: state.userId,
    role: 'MEMBER',
    joinedAt: at,
    leftAt: null,
    addedBy: null,
    // Nobody is greeted with the whole backlog as unread.
    lastReadSequence: conversation.lastSequence,
    hiddenThroughSequence: history === 'FULL' ? 0 : conversation.lastSequence,
    ...source,
  });

  if (row === null) {
    if (state.active) return { next: joining(), transition: 'joined', delta: 1 };
    return {
      next: {
        conversationId: conversation.id,
        userId: state.userId,
        role: 'MEMBER',
        joinedAt: at,
        leftAt: at,
        addedBy: null,
        lastReadSequence: 0,
        hiddenThroughSequence: 0,
        ...source,
      },
      transition: 'tombstoned',
      delta: 0,
    };
  }

  if (row.leftAt === null) {
    if (!state.active) {
      return {
        next: { ...row, leftAt: at < row.joinedAt ? row.joinedAt : at, ...source },
        transition: 'left',
        delta: -1,
      };
    }
    return row.sourceMembershipId === state.membershipId
      ? { next: { ...row, ...source }, transition: 'bumped', delta: 0 }
      : { next: joining(), transition: 'rejoined', delta: 0 };
  }

  return state.active
    ? { next: joining(), transition: 'rejoined', delta: 1 }
    : { next: { ...row, ...source }, transition: 'bumped', delta: 0 };
}

/** Whether the row already says exactly what the state says. */
function reflects(row: Participant, state: CommunityMemberState): boolean {
  return (
    row.sourceVersion === state.version &&
    row.sourceMembershipId === state.membershipId &&
    row.sourceJoinedAt?.getTime() === state.joinedAt.getTime() &&
    (row.leftAt === null) === state.active
  );
}

/**
 * One apply's batch: at most MAX_APPLY_BATCH states, one per member. A
 * RangeError otherwise — a caller bug, never a partial apply.
 */
export function checkApplyBatch(states: readonly CommunityMemberState[]): void {
  if (states.length > MAX_APPLY_BATCH) {
    throw new RangeError(`At most ${MAX_APPLY_BATCH} member states per apply.`);
  }
  if (new Set(states.map((state) => state.userId)).size !== states.length) {
    throw new RangeError('An apply names each member once.');
  }
}

/** What one apply did, for the caller's metrics and tests. */
export interface ApplyCounts {
  readonly joined: number;
  readonly rejoined: number;
  readonly left: number;
  readonly tombstoned: number;
}

/**
 * The projection's version after an apply (§6.3, C6): it moves forward only,
 * and only across a contiguous range — everything up to `from` must already
 * be reflected for `to` to be claimed. `greatest` keeps it monotonic when
 * another applier already went further.
 */
export function advancedProjection(
  current: number,
  advance: { readonly from: number; readonly to: number } | null,
): number {
  if (advance === null || current < advance.from) return current;
  return Math.max(current, advance.to);
}

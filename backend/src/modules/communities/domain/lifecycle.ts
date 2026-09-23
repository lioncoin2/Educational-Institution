import type { CommunityAct } from '../contracts/capabilities';
import type { LifecycleEffects } from '../contracts/membership';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  PROVISIONAL — what LOCKED means is not confirmed by the institution (Q46)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One table, two views (§8.3): `statePermits(status, act)` is what
 * COMMUNITY_AUTHORIZATION applies; `effectsOf(status)` is what principal-less
 * consumers see through COMMUNITY_MEMBERSHIP. No other module sees a raw
 * status, so changing what LOCKED means edits this file, its test and Q46 —
 * and no consumer.
 *
 *              acceptsMembers chatReadable chatPostingOpen liveStartOpen liveJoinOpen runningLiveContinues
 *   OPEN            T              T             T              T             T               T
 *   LOCKED          F              T             F              F             T               T
 *   unmapped        F              F             F              F             F               T
 *
 * An unmapped status (one a later migration added, read by an older build)
 * closes every new action, keeps management open, and ejects nobody from a
 * running live session.
 */
const OPEN: LifecycleEffects = Object.freeze({
  acceptsMembers: true,
  chatReadable: true,
  chatPostingOpen: true,
  liveStartOpen: true,
  liveJoinOpen: true,
  runningLiveContinues: true,
});

const LOCKED: LifecycleEffects = Object.freeze({
  acceptsMembers: false,
  chatReadable: true,
  chatPostingOpen: false,
  liveStartOpen: false,
  liveJoinOpen: true,
  runningLiveContinues: true,
});

const UNMAPPED: LifecycleEffects = Object.freeze({
  acceptsMembers: false,
  chatReadable: false,
  chatPostingOpen: false,
  liveStartOpen: false,
  liveJoinOpen: false,
  // Never eject on ignorance.
  runningLiveContinues: true,
});

export function effectsOf(status: string): LifecycleEffects {
  if (status === 'OPEN') return OPEN;
  if (status === 'LOCKED') return LOCKED;
  return UNMAPPED;
}

/** Which effect an act needs; `always` is management, which no status closes. */
export type LifecycleGate = keyof LifecycleEffects | 'always';

/**
 * The gate of every act. Management — viewing, the roster, removing, and
 * locking itself — is never closed, so a locked community can always be
 * unlocked, and nobody running a live session is ejected by a lock.
 */
export const GATE_OF_ACT: Readonly<Record<CommunityAct, LifecycleGate>> = Object.freeze({
  'community.view': 'always',
  'community.members.view': 'always',
  'community.members.remove': 'always',
  'community.lock': 'always',
  'community.members.invite': 'acceptsMembers',
  'community.chat.read': 'chatReadable',
  'community.chat.post': 'chatPostingOpen',
  'community.live.start': 'liveStartOpen',
  'community.live.join': 'liveJoinOpen',
  'community.live.raise_hand': 'liveJoinOpen',
  'community.live.moderate': 'always',
  'community.live.host': 'runningLiveContinues',
});

export function permitsGate(status: string, gate: LifecycleGate): boolean {
  return gate === 'always' || effectsOf(status)[gate];
}

export function statePermits(status: string, act: CommunityAct): boolean {
  return permitsGate(status, GATE_OF_ACT[act]);
}

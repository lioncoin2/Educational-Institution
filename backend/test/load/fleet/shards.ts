/**
 * P8.4 — participant sharding (design §4). A run is one room
 * `loadtest-p84-<runId>` holding one publisher, on a dedicated worker of
 * agent 0 (§5), and N−1 listeners whose GLOBAL indices are cut into
 * contiguous, disjoint ranges: evenly across hosts, then per host into as few
 * worker processes as the density cap allows. Identities derive from
 * (runId, index) alone, so the controller's minted set, an agent's shard
 * scoping and the server-side identity check (§7) agree without exchanging
 * lists.
 *
 * Splits are balanced (sizes differ by at most one); mp/partition.ts's ceiling
 * split is not reused because it can leave the last worker nearly empty.
 * Pure, apart from newRunId's CSPRNG read.
 */
import { randomBytes } from 'node:crypto';

import { LOAD_ROOM_PREFIX } from '../core/identity';
import { type WorkerSpec } from './protocol';

const RUN_ID = /^[0-9a-f]{16}$/;
/** Listener indices are printed with this many digits (`L00042`). */
const LISTENER_INDEX_DIGITS = 5;
/** Exclusive upper bound of a listener index, fixed by the identity width. */
const LISTENER_INDEX_LIMIT = 10 ** LISTENER_INDEX_DIGITS;

/** A fresh run id: 64 bits from the CSPRNG as 16 lowercase hex chars (design §2). */
export function newRunId(): string {
  return randomBytes(8).toString('hex');
}

/** The short run tag embedded in every identity: the run id's first 8 chars. */
export function runTag(runId: string): string {
  assertRunId(runId);
  return runId.slice(0, 8);
}

/** The run's single room; the `loadtest-` prefix keeps the app reconciler away (plan F7). */
export function roomFor(runId: string): string {
  assertRunId(runId);
  return `${LOAD_ROOM_PREFIX}p84-${runId}`;
}

export function publisherIdentity(runId: string): string {
  return `p84-${runTag(runId)}-P0`;
}

export function listenerIdentity(runId: string, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= LISTENER_INDEX_LIMIT)
    throw new RangeError(`listener index must be an integer in [0, ${LISTENER_INDEX_LIMIT})`);
  return `p84-${runTag(runId)}-L${String(index).padStart(LISTENER_INDEX_DIGITS, '0')}`;
}

export interface ShardPlanInput {
  readonly runId: string;
  /** N: one publisher plus N−1 listeners. */
  readonly participants: number;
  /** Generator hosts, i.e. agents. */
  readonly hosts: number;
  /** Most listeners one worker process may hold (the measured d*, design §16). */
  readonly density: number;
}

/** One worker process and the participants it will be admitted. */
export interface WorkerShard {
  /** Global shard index = the aggregator's `workerId`: publisher 0, listeners 1..W. */
  readonly workerId: number;
  readonly agentIndex: number;
  readonly kind: WorkerSpec['kind'];
  /** Listener index range [start, end); the publisher shard has start = end = 0. */
  readonly start: number;
  readonly end: number;
}

export interface ShardPlan {
  readonly publisher: WorkerShard;
  /** Ordered by workerId, which is also listener-index order. */
  readonly listeners: readonly WorkerShard[];
  readonly totalListeners: number;
}

/**
 * The fleet's shard plan. Listeners are split across hosts with the remainder
 * on the LAST hosts, so with agent 0's publisher the per-host participant
 * counts also differ by at most one. Deterministic; throws RangeError on
 * invalid input.
 */
export function planShards(input: ShardPlanInput): ShardPlan {
  const { runId, participants, hosts, density } = input;
  assertRunId(runId);
  requireInteger('participants', participants, 2);
  requireInteger('hosts', hosts, 1);
  requireInteger('density', density, 1);
  const totalListeners = participants - 1;
  if (totalListeners > LISTENER_INDEX_LIMIT)
    throw new RangeError(`at most ${LISTENER_INDEX_LIMIT} listeners fit the identity format`);

  const listeners: WorkerShard[] = [];
  let next = 0;
  balancedSplit(totalListeners, hosts)
    .reverse()
    .forEach((share, agentIndex) => {
      for (const size of balancedSplit(share, Math.ceil(share / density))) {
        listeners.push({
          workerId: listeners.length + 1,
          agentIndex,
          kind: 'listeners',
          start: next,
          end: next + size,
        });
        next += size;
      }
    });
  return {
    publisher: { workerId: 0, agentIndex: 0, kind: 'publisher', start: 0, end: 0 },
    listeners,
    totalListeners,
  };
}

/** The identities a shard's tickets are minted for, in index order. */
export function identitiesOf(runId: string, shard: WorkerShard): string[] {
  if (shard.kind === 'publisher') return [publisherIdentity(runId)];
  const identities: string[] = [];
  for (let index = shard.start; index < shard.end; index += 1)
    identities.push(listenerIdentity(runId, index));
  return identities;
}

/** `total` as `parts` sizes differing by at most one, larger first (none when parts is 0). */
function balancedSplit(total: number, parts: number): number[] {
  if (parts === 0) return [];
  const base = Math.floor(total / parts);
  const extra = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new RangeError('runId must be 16 lowercase hex chars');
}

function requireInteger(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min)
    throw new RangeError(`${name} must be an integer >= ${min} (got ${value})`);
}

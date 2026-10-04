/**
 * P8.4 — just-in-time admission (design §2, §5, §6). The controller's global
 * ramp grants admissions; each grant MINTS one scoped ticket for the next
 * identity of the chosen shard and relays it to that shard's agent. Minting is
 * the admission, so pacing, ticket lifetime and the global rate are one
 * mechanism. Every identity is minted at most once per run, and the ledger here
 * is what scopes agent reports: an agent may only speak for identities minted
 * to its own workers.
 */
import { type MediaTicket, type WorkerParticipant } from '../mp/types';
import { type TicketRole } from '../livekit/tokens';
import { type GlobalRamp } from './ramp';
import { type ShardPlan, type WorkerShard, listenerIdentity, publisherIdentity } from './shards';

export interface AdmissionDeps {
  readonly mint: (identity: string, role: TicketRole) => Promise<MediaTicket>;
  readonly admit: (agentIndex: number, workerId: number, participant: WorkerParticipant) => void;
  readonly ramp: GlobalRamp;
  readonly now: () => number;
}

export class Admission {
  private readonly nextIndex = new Map<number, number>();
  private readonly owner = new Map<string, number>();
  private readonly issued = new Map<string, number>();
  private readonly inFlight = new Map<number, number>();
  private readonly done = new Set<string>();
  private readonly listenerGranted: number[] = [];
  private readonly shards: Map<number, WorkerShard>;

  constructor(
    private readonly plan: ShardPlan,
    private readonly runId: string,
    private readonly room: string,
    private readonly d: AdmissionDeps,
  ) {
    this.shards = new Map(plan.listeners.map((s) => [s.workerId, s]));
    for (const s of plan.listeners) this.nextIndex.set(s.workerId, s.start);
  }

  /** Phase A: the single publisher, on its dedicated worker. */
  async admitPublisher(): Promise<string> {
    const identity = publisherIdentity(this.runId);
    await this.issue(this.plan.publisher, identity, 'publisher', 'speaker');
    return identity;
  }

  /** Phase B: one ramp step — grants, mints and relays; returns how many were admitted. */
  async tick(): Promise<number> {
    const demand = this.plan.listeners.map((s) => ({
      workerId: s.workerId,
      remaining: s.end - (this.nextIndex.get(s.workerId) ?? s.end),
      inFlight: this.inFlight.get(s.workerId) ?? 0,
    }));
    const grantedAt = this.d.now();
    const grants = this.d.ramp.grant(grantedAt, demand);
    for (const workerId of grants) {
      const shard = this.shards.get(workerId);
      const index = this.nextIndex.get(workerId);
      if (!shard || index === undefined || index >= shard.end) continue;
      this.nextIndex.set(workerId, index + 1);
      await this.issue(shard, listenerIdentity(this.runId, index), 'listener', 'listener');
      this.listenerGranted.push(grantedAt);
    }
    return grants.length;
  }

  /** A participant reached a terminal connect outcome (connected or failed). */
  resolved(identity: string): void {
    const workerId = this.owner.get(identity);
    // Idempotent per identity: agent input is untrusted, a repeated terminal event frees nothing.
    if (workerId === undefined || this.done.has(identity)) return;
    this.done.add(identity);
    this.inFlight.set(workerId, Math.max(0, (this.inFlight.get(workerId) ?? 0) - 1));
  }

  /** True only for an identity minted to exactly this worker. */
  owns(workerId: number, identity: string): boolean {
    return this.owner.get(identity) === workerId;
  }

  allAdmitted(): boolean {
    return this.plan.listeners.every((s) => (this.nextIndex.get(s.workerId) ?? s.end) >= s.end);
  }

  issuedAt(identity: string): number | undefined {
    return this.issued.get(identity);
  }

  minted(): ReadonlySet<string> {
    return new Set(this.owner.keys());
  }

  /**
   * When the global ramp granted each listener admission, in order: the measured ramp. Grant
   * time, not issue time — `issuedAt` follows the mint, whose latency (a cold first JWT signing)
   * would compress the span and over-report the rate.
   */
  listenerGrantTimes(): readonly number[] {
    return [...this.listenerGranted];
  }

  private async issue(
    shard: WorkerShard,
    identity: string,
    ticketRole: TicketRole,
    role: WorkerParticipant['role'],
  ): Promise<void> {
    if (this.owner.has(identity)) throw new Error(`identity ${identity} already minted`);
    const ticket = await this.d.mint(identity, ticketRole);
    this.owner.set(identity, shard.workerId);
    this.issued.set(identity, this.d.now());
    this.inFlight.set(shard.workerId, (this.inFlight.get(shard.workerId) ?? 0) + 1);
    this.d.admit(shard.agentIndex, shard.workerId, { identity, room: this.room, role, ticket });
  }
}

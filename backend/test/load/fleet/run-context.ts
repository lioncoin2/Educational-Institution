/**
 * P8.4 — the state of ONE rung run inside the controller (design §1, §7): the
 * single aggregator, the shard plan, admission, the agent session, the monitor,
 * the timeline and the global abort. It also handles everything agents send —
 * identity scoping (an agent may only speak for identities minted to its own
 * workers), live validity aborts (relay in TURN-free mode, duplicate identity,
 * lost agent) and crash accounting. The phase sequence is the controller's.
 */
import { MpAggregator } from '../mp/aggregate';
import { transportProblems } from '../mp/media-health';
import { type WorkerMessage } from '../mp/types';
import { type AbortReason, ABORT_SCHEMA } from '../observe/sample';
import { FreshWorst } from '../observe/watchdog';
import { Admission } from './admission';
import { serverIdentityProblems } from './gates';
import { RunMonitor } from './monitor';
import { GlobalRamp } from './ramp';
import { type ControllerDeps, type ControllerTiming, type RungRequest } from './rung-config';
import { type AgentHello, FleetSession } from './session';
import { type ShardPlan, planShards, publisherIdentity, roomFor } from './shards';

export type Phase = 'prepare' | 'A' | 'B' | 'gate' | 'hold' | 'teardown';

export interface Timeline {
  rampStart: number | null;
  rampEnd: number | null;
  gateAt: number | null;
  holdStart: number | null;
  holdEnd: number | null;
  /** When the gate (or phase A) failed; the classification lookback ends here. */
  failureAt: number | null;
}

export interface ServerView {
  atGate: boolean | null;
  atHoldEnd: boolean | null;
  countAtGate: number | null;
  countAtHoldEnd: number | null;
}

export class RunContext {
  readonly startedAt: number;
  readonly n: number;
  readonly agg: MpAggregator;
  readonly plan: ShardPlan;
  readonly room: string;
  readonly publisher: string;
  readonly monitor: RunMonitor;
  readonly session: FleetSession;
  readonly admission: Admission;
  readonly connectMs: number[] = [];
  readonly timeline: Timeline = {
    rampStart: null,
    rampEnd: null,
    gateAt: null,
    holdStart: null,
    holdEnd: null,
    failureAt: null,
  };
  readonly server: ServerView = {
    atGate: null,
    atHoldEnd: null,
    countAtGate: null,
    countAtHoldEnd: null,
  };
  phase: Phase = 'prepare';
  abort: AbortReason | null = null;
  hellos: AgentHello[] = [];
  private readonly crashes = new Map<number, number>();
  /** Per agent: the worst worker lag window since that agent's previous sample. */
  private readonly lag = new Map<number, FreshWorst>();

  constructor(
    readonly req: RungRequest,
    readonly deps: ControllerDeps,
    readonly timing: ControllerTiming,
  ) {
    const now = deps.now;
    this.startedAt = now();
    this.n = req.rung.participants;
    this.agg = new MpAggregator(this.n, 1);
    this.plan = planShards({
      runId: req.runId,
      participants: this.n,
      hosts: deps.endpoints.length,
      density: req.density,
    });
    this.room = roomFor(req.runId);
    this.publisher = publisherIdentity(req.runId);
    this.monitor = new RunMonitor(
      { runId: req.runId, rung: req.rung.id, intervalMs: timing.sampleIntervalMs },
      deps.sut,
      (r) => this.raise(r),
    );
    this.session = new FleetSession(
      deps.pm,
      {
        onWorker: (agent, msg) => this.onWorker(agent, msg),
        onExit: (agent, workerId, forced, code, signal) =>
          this.onExit(agent, workerId, forced, code, signal),
        onSample: (agent, sample) => {
          this.monitor.addGeneratorSample(
            agent,
            sample,
            this.crashes.get(agent) ?? 0,
            this.lag.get(agent)?.take() ?? null,
          );
          if (req.ice === 'turn-free' && (sample.gen?.flowsToSut3478 ?? 0) > 0)
            this.raiseController('V-turn', `${sample.host}: flow to SUT:3478`, 'F');
        },
        onAbort: (_agent, reason) => this.raise(reason),
        onLost: (agent, why) => this.raiseController('agent-lost', `agent ${agent}: ${why}`, 'A'),
      },
      now,
    );
    this.admission = new Admission(this.plan, req.runId, this.room, {
      mint: deps.mint,
      admit: (a, w, p) => this.session.admit(a, w, p),
      ramp: new GlobalRamp({
        ratePerSecond: req.rampPerSecond,
        inFlightLimit: timing.inFlightPerWorker,
      }),
      now,
    });
  }

  /** The first abort wins; later ones are consequences. */
  raise(reason: AbortReason): void {
    this.abort ??= reason;
  }

  /** A controller-originated abort; every one of them is a validity (not SUT) cause. */
  raiseController(rule: string, detail: string, classHint: AbortReason['classHint']): void {
    this.raise({
      schema: ABORT_SCHEMA,
      runId: this.req.runId,
      rung: this.req.rung.id,
      at: this.deps.now(),
      source: 'controller',
      rule,
      observed: { value: detail, unit: '', samples: [] },
      threshold: null,
      classHint,
      validity: true,
      detail,
    });
  }

  /** Why the run cannot proceed (abort or unreachable exact-N), or null. */
  blocked(): string | null {
    if (this.abort) return `abort: ${this.abort.rule}`;
    const u = this.agg.unreachable();
    return u.yes ? u.reason : null;
  }

  /** Polls `check` until true, blocked, or timed out; returns null on success, else why. */
  async waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<string | null> {
    const deadline = this.deps.now() + timeoutMs;
    for (;;) {
      const b = this.blocked();
      if (b) return b;
      if (await check()) return null;
      if (this.deps.now() >= deadline) return 'timeout';
      await this.deps.sleep(Math.max(this.timing.tickMs, 250));
    }
  }

  /** The SFU's own participant list vs the minted set; an identity nobody minted aborts (integrity). */
  async serverCheck(): Promise<{ ok: boolean; count: number; problems: string[] }> {
    const list = await this.deps.rooms.participants(this.room);
    const minted = this.admission.minted();
    const problems = serverIdentityProblems(list, minted, this.publisher);
    const foreign = list.filter((p) => !minted.has(p.identity)).length;
    if (foreign > 0)
      this.raiseController(
        'server-identity',
        `${foreign} identities nobody minted on the SFU`,
        'F',
      );
    return { ok: problems.length === 0, count: list.length, problems };
  }

  /** A stable per-agent key: its index plus the hostname it reported (hostnames may repeat). */
  agentKey(index: number): string {
    return `agent-${index}:${this.hellos[index]?.host.hostname ?? 'unknown'}`;
  }

  agentIndexOfWorker(workerId: number): number {
    if (workerId === this.plan.publisher.workerId) return this.plan.publisher.agentIndex;
    return this.plan.listeners.find((s) => s.workerId === workerId)?.agentIndex ?? -1;
  }

  workerIds(): number[] {
    return [this.plan.publisher.workerId, ...this.plan.listeners.map((s) => s.workerId)];
  }

  private onWorker(agent: number, msg: WorkerMessage): void {
    const now = this.deps.now();
    if ('participantId' in msg && !this.admission.owns(msg.workerId, msg.participantId)) {
      this.raiseController('identity-scope', `agent ${agent} reported ${msg.participantId}`, 'F');
      return;
    }
    this.agg.record(msg, now);
    void this.deps.csv?.write(this.req.runId, msg, this.agg.connected());
    if (msg.type === 'connected' || msg.type === 'failed') {
      this.admission.resolved(msg.participantId);
      const issued = this.admission.issuedAt(msg.participantId);
      if (msg.type === 'connected' && issued !== undefined) this.connectMs.push(now - issued);
    }
    if (msg.type === 'mediaWindow') {
      const fresh = this.lag.get(agent) ?? new FreshWorst();
      fresh.add(msg.window.loopLagMsP95);
      this.lag.set(agent, fresh);
    }
    if (msg.type === 'transport' && this.req.ice === 'turn-free') {
      const problems = transportProblems(msg.report, {
        mode: 'turn-free',
        udpPort: this.req.udpPort,
      });
      if (problems.length > 0)
        this.raiseController('V-turn', `${msg.participantId}: ${problems.join('; ')}`, 'F');
    }
    if (msg.type === 'mediaFault' && msg.reason === 'DUPLICATE_IDENTITY')
      this.raiseController('V-dup', `${msg.participantId} evicted`, 'F');
  }

  private onExit(
    agent: number,
    workerId: number,
    forced: boolean,
    code: number | null,
    signal: string | null,
  ): void {
    this.agg.recordExit(workerId, code, signal);
    if (forced) this.agg.recordForcedKill(workerId);
    if (this.phase === 'teardown') return;
    // A worker exits only after shutdown: any earlier exit is a crash.
    this.crashes.set(agent, (this.crashes.get(agent) ?? 0) + 1);
    this.agg.record(
      { type: 'fatal', workerId, error: `worker exited before shutdown (${code}/${signal})` },
      this.deps.now(),
    );
  }
}

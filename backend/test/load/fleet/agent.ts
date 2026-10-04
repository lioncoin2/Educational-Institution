/**
 * P8.4 — the generator AGENT (design §3): one per generator VM, driven by the
 * controller over NDJSON. It owns exactly one host's shard — spawning its worker
 * processes (through the single spawn primitive), relaying just-in-time
 * tickets to them, forwarding their events verbatim, sampling its own host and
 * running the GENERATOR watchdog — and nothing else: it mints nothing, holds no
 * RoomService credential and computes no gate.
 *
 * It stops (bounded, P8.3.8 teardown semantics) on the controller's `shutdown`,
 * on a dead-man timeout (no controller heartbeat), on stdin EOF, or on a
 * signal; every path is the same `stop()`.
 */
import {
  type ControllerMessage,
  type AgentMessage,
  type AssignSettings,
  type HostFacts,
  PROTOCOL_VERSION,
  type WorkerSpec,
} from './protocol';
import { type OwnedProcess, type ProcessManager, childEnv } from '../mp/process-manager';
import { type WorkerAssignment, type WorkerMessage } from '../mp/types';
import { deriveGenerator } from '../observe/derive';
import { RULES } from '../observe/rules';
import { type AbortReason, ABORT_SCHEMA, type HostSample } from '../observe/sample';
import { FreshWorst, LAG_UNOBSERVED, Watchdog } from '../observe/watchdog';

export interface AgentOptions {
  readonly runId: string;
  readonly commit: string;
  readonly bundleSha256: string | null;
  readonly workerModule: string;
  readonly host: HostFacts;
}

export interface AgentDeps {
  readonly send: (msg: AgentMessage) => void;
  readonly pm: ProcessManager;
  readonly sample: (
    procs: ReadonlyArray<{ readonly pid: number; readonly role: string }>,
    participants: number,
    ctx: { readonly rung: string; readonly sutAddress: string },
  ) => Promise<HostSample>;
  /** Starts the in-process STUN responder; resolves to its `stun:` URL. */
  readonly startStun: () => Promise<{ readonly url: string; close(): Promise<void> }>;
  /** Records the agent's own and its children's PIDs for `stop <runId>`. */
  readonly record: (
    children: ReadonlyArray<{ readonly pid: number; readonly label: string }>,
  ) => Promise<void>;
  readonly now: () => number;
  readonly exit: (code: number) => void;
}

const TS_NODE = ['-r', 'ts-node/register/transpile-only'];

export class Agent {
  private settings: AssignSettings | null = null;
  private rung = '';
  private stun: { url: string; close(): Promise<void> } | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private lastController: number;
  private stopping: Promise<void> | null = null;
  private readonly participants = new Map<number, number>();
  /** Worst worker lag window since the previous host sample (each window judged once). */
  private readonly freshLag = new FreshWorst();
  private crashes = 0;
  private sampling = false;
  private baseline: HostSample | null = null;
  private prev: HostSample | null = null;
  private watchdog = new Watchdog(RULES, 'generator');

  constructor(
    private readonly o: AgentOptions,
    private readonly d: AgentDeps,
  ) {
    this.lastController = d.now();
  }

  start(): void {
    this.d.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      commit: this.o.commit,
      bundleSha256: this.o.bundleSha256,
      node: process.version,
      host: this.o.host,
    });
  }

  handle(msg: ControllerMessage): void {
    this.lastController = this.d.now();
    switch (msg.type) {
      case 'assign':
        void this.assign(msg.rung, msg.workers, msg.settings).catch((e: unknown) =>
          this.abort('agent-assign', String((e as Error)?.message ?? e)),
        );
        return;
      case 'admit': {
        const worker = this.d.pm.get(msg.workerId);
        if (worker?.child.connected)
          worker.child.send({ type: 'admit', participant: msg.participant });
        return;
      }
      case 'shutdown':
        void this.stop();
        return;
      case 'heartbeat':
        return;
    }
  }

  /** The single stop path: bounded worker shutdown, STUN closed, `bye`, exit. Idempotent. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      for (const t of this.timers) clearInterval(t);
      this.timers = [];
      for (const w of this.d.pm.alive()) if (w.child.connected) w.child.send({ type: 'shutdown' });
      await this.d.pm.waitAllExited(this.settings?.shutdownGraceMs ?? 10_000);
      await this.stun?.close().catch(() => undefined);
      this.d.send({
        type: 'bye',
        spawned: this.d.pm.list().length,
        liveChildren: this.d.pm.alive().length,
      });
      this.d.exit(0);
    })();
    return this.stopping;
  }

  private async assign(
    rung: string,
    workers: readonly WorkerSpec[],
    s: AssignSettings,
  ): Promise<void> {
    if (this.settings) throw new Error('already assigned');
    this.settings = s;
    this.rung = rung;
    if (s.ice.mode === 'turn-free') this.stun = await this.d.startStun();
    const ice: WorkerAssignment['ice'] =
      s.ice.mode === 'turn-free'
        ? { mode: 'turn-free', stunUrls: [this.stun?.url ?? ''] }
        : { mode: 'relay' };
    for (const spec of workers) this.spawnWorker(spec, ice, s);
    await this.d.record(this.d.pm.list().map((p) => ({ pid: p.child.pid ?? 0, label: p.label })));
    this.timers.push(
      setInterval(() => this.d.send({ type: 'heartbeat', t: this.d.now() }), s.heartbeatMs),
    );
    this.timers.push(
      setInterval(() => {
        if (this.d.now() - this.lastController > s.deadManMs) void this.stop();
      }, s.heartbeatMs),
    );
    this.timers.push(setInterval(() => void this.sampleOnce(), s.sampleIntervalMs));
    this.d.send({ type: 'ready', workers: workers.length, stunUrl: this.stun?.url ?? null });
  }

  private spawnWorker(
    spec: WorkerSpec,
    ice: WorkerAssignment['ice'],
    s: AssignSettings,
  ): OwnedProcess {
    const proc = this.d.pm.spawn(spec.workerId, {
      label: `worker:${spec.workerId}`,
      mode: 'fork',
      command: this.o.workerModule,
      args: [],
      env: childEnv(process.env),
      execArgv: TS_NODE,
    });
    void proc.exited.then(() => {
      if (!this.stopping) this.crashes += 1; // a worker exits only after shutdown
    });
    proc.child.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'mediaWindow') this.freshLag.add(msg.window.loopLagMsP95);
      if (msg.type === 'connected')
        this.participants.set(spec.workerId, (this.participants.get(spec.workerId) ?? 0) + 1);
      this.d.send({ type: 'worker', workerId: spec.workerId, msg });
    });
    const assignment: WorkerAssignment = {
      runId: this.o.runId,
      workerId: spec.workerId,
      ice,
      screen: null,
      publishRetries: s.publishRetries,
      teardownTimeoutMs: s.teardownTimeoutMs,
      statsIntervalMs: s.statsIntervalMs,
      probe: spec.probe,
    };
    proc.child.send(assignment);
    return proc;
  }

  private async sampleOnce(): Promise<void> {
    if (this.stopping || this.sampling) return; // never overlap: a slow sample delays, not stacks
    this.sampling = true;
    try {
      await this.sampleAndJudge();
    } finally {
      this.sampling = false;
    }
  }

  private async sampleAndJudge(): Promise<void> {
    const procs = this.d.pm
      .alive()
      .flatMap((p) => (p.child.pid ? [{ pid: p.child.pid, role: p.label }] : []));
    procs.push({ pid: process.pid, role: 'agent' });
    const live = [...this.participants.values()].reduce((a, b) => a + b, 0);
    const sample = await this.d.sample(procs, live, {
      rung: this.rung,
      sutAddress: this.settings?.sutAddress ?? '',
    });
    this.d.send({ type: 'sample', sample });
    this.baseline ??= sample;
    const lag = this.freshLag.take();
    const { metrics } = deriveGenerator(this.baseline, this.prev, sample, {
      linkMbps: sample.gen?.linkMbps ?? null,
      loopLagP95Ms: lag,
    });
    this.prev = sample;
    const group = sample.gen?.processGroup ?? null;
    const step = this.watchdog.observe(
      sample.t,
      {
        ...metrics,
        gWorkerCrashes: this.crashes,
        gUnexplainedProcs: group === null ? null : group.unexplained,
      },
      lag === null ? LAG_UNOBSERVED : undefined,
    );
    for (const f of step.fired)
      this.abort(f.ruleId, `generator rule ${f.ruleId} fired at ${f.value}`, f.value);
  }

  private abort(rule: string, detail: string, value: number | string = ''): void {
    const reason: AbortReason = {
      schema: ABORT_SCHEMA,
      runId: this.o.runId,
      rung: this.rung,
      at: this.d.now(),
      source: `gen-watchdog:${this.o.host.hostname}`,
      rule,
      observed: { value, unit: '', samples: [] },
      threshold: null,
      classHint: 'A',
      validity: true,
      detail,
    };
    this.d.send({ type: 'abort', reason });
  }
}

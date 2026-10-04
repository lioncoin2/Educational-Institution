/**
 * P8.4 — the controller's view of its agents (design §3): spawns one agent per
 * endpoint through the single spawn primitive, frames NDJSON on each agent's
 * stdio, verifies every `hello` (protocol + commit), routes messages, sends
 * heartbeats and notices a lost agent. Agent input is UNTRUSTED: an envelope
 * whose worker id was not assigned to that agent is a protocol violation.
 * Identity scoping (participant ⊆ minted to that worker) is the controller's.
 */
import { type Writable } from 'node:stream';

import { type ProcessManager } from '../mp/process-manager';
import { type WorkerMessage, type WorkerParticipant } from '../mp/types';
import { type AbortReason, type HostSample } from '../observe/sample';
import { readLines, writeMessage } from './channel';
import { type AgentEndpoint, agentSpawnSpec } from './endpoints';
import {
  type AgentMessage,
  type AssignSettings,
  type ControllerMessage,
  type HostFacts,
  PROTOCOL_VERSION,
  type WorkerSpec,
  decodeAgentMessage,
} from './protocol';

export interface SessionHandlers {
  readonly onWorker: (agent: number, msg: WorkerMessage) => void;
  readonly onExit: (
    agent: number,
    workerId: number,
    forced: boolean,
    code: number | null,
    signal: string | null,
  ) => void;
  readonly onSample: (agent: number, sample: HostSample) => void;
  readonly onAbort: (agent: number, reason: AbortReason) => void;
  /** Lost, closed early or misbehaving; the controller aborts the fleet. */
  readonly onLost: (agent: number, why: string) => void;
}

interface Link {
  readonly index: number;
  readonly endpoint: AgentEndpoint;
  readonly stdin: Writable;
  lastSeen: number;
  hello: Extract<AgentMessage, { type: 'hello' }> | null;
  ready: Extract<AgentMessage, { type: 'ready' }> | null;
  bye: Extract<AgentMessage, { type: 'bye' }> | null;
  ended: boolean;
  readonly workers: Set<number>;
}

export interface AgentHello {
  readonly index: number;
  readonly host: HostFacts;
  readonly commit: string;
  readonly bundleSha256: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class FleetSession {
  private readonly links: Link[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closing = false;

  constructor(
    private readonly pm: ProcessManager,
    private readonly h: SessionHandlers,
    private readonly now: () => number = Date.now,
  ) {}

  start(endpoints: readonly AgentEndpoint[], runId: string, parentEnv: NodeJS.ProcessEnv): void {
    endpoints.forEach((endpoint, index) => {
      const proc = this.pm.spawn(index, agentSpawnSpec(endpoint, runId, parentEnv));
      const { stdin, stdout } = proc.child;
      if (!stdin || !stdout) throw new Error(`agent ${index} has no stdio`);
      const link: Link = {
        index,
        endpoint,
        stdin,
        lastSeen: this.now(),
        hello: null,
        ready: null,
        bye: null,
        ended: false,
        workers: new Set(),
      };
      this.links.push(link);
      // A write to an agent that is gone fails ASYNCHRONOUSLY (EPIPE on its stdin): that is a lost
      // link, never an uncaught exception that would take the controller down mid-rung.
      stdin.on('error', (e: NodeJS.ErrnoException) => {
        link.ended = true;
        if (!this.closing) this.h.onLost(index, `agent stdin: ${e.code ?? e.message}`);
      });
      readLines(stdout, decodeAgentMessage, {
        onMessage: (msg) => this.route(link, msg),
        onProtocolError: (error) => this.h.onLost(index, `protocol error: ${error}`),
        onEnd: () => {
          link.ended = true;
          if (!this.closing) this.h.onLost(index, 'agent stream ended');
        },
      });
    });
  }

  /** Waits for every hello and checks protocol and commit. */
  async hellos(timeoutMs: number, expectCommit: string): Promise<AgentHello[]> {
    await this.until(() => this.links.every((l) => l.hello), timeoutMs, 'hello');
    return this.links.map((l) => {
      const hello = l.hello!;
      if (hello.protocol !== PROTOCOL_VERSION)
        throw new Error(`agent ${l.index} speaks ${hello.protocol}, expected ${PROTOCOL_VERSION}`);
      if (hello.commit !== expectCommit)
        throw new Error(`agent ${l.index} runs commit ${hello.commit}, expected ${expectCommit}`);
      return {
        index: l.index,
        host: hello.host,
        commit: hello.commit,
        bundleSha256: hello.bundleSha256,
      };
    });
  }

  assign(
    index: number,
    runId: string,
    rung: string,
    workers: readonly WorkerSpec[],
    settings: AssignSettings,
  ): void {
    const link = this.links[index];
    if (!link) throw new Error(`no agent ${index}`);
    for (const w of workers) link.workers.add(w.workerId);
    this.send(link, { type: 'assign', runId, rung, agentIndex: index, workers, settings });
  }

  /** Waits for every agent's `ready`; returns each agent's STUN URL. */
  async readies(timeoutMs: number): Promise<Array<string | null>> {
    await this.until(() => this.links.every((l) => l.ready), timeoutMs, 'ready');
    return this.links.map((l) => l.ready?.stunUrl ?? null);
  }

  admit(index: number, workerId: number, participant: WorkerParticipant): void {
    const link = this.links[index];
    if (link) this.send(link, { type: 'admit', workerId, participant });
  }

  startHeartbeats(everyMs: number, deadManMs: number): void {
    this.heartbeat = setInterval(() => {
      for (const l of this.links) {
        this.send(l, { type: 'heartbeat', t: this.now() });
        if (!this.closing && this.now() - l.lastSeen > deadManMs)
          this.h.onLost(l.index, 'no heartbeat');
      }
    }, everyMs);
  }

  /** Asks every agent to stop and waits (bounded) for each `bye` and process exit. */
  async shutdown(
    reason: string,
    timeoutMs: number,
  ): Promise<Array<{ index: number; bye: boolean; liveChildren: number | null }>> {
    this.closing = true;
    for (const l of this.links) this.send(l, { type: 'shutdown', reason });
    await this.until(() => this.links.every((l) => l.bye || l.ended), timeoutMs, 'bye').catch(
      () => undefined,
    );
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const l of this.links) l.stdin.end();
    await this.pm.waitAllExited(timeoutMs);
    return this.links.map((l) => ({
      index: l.index,
      bye: l.bye !== null,
      liveChildren: l.bye?.liveChildren ?? null,
    }));
  }

  endpoint(index: number): AgentEndpoint | undefined {
    return this.links[index]?.endpoint;
  }

  private route(link: Link, msg: AgentMessage): void {
    link.lastSeen = this.now();
    switch (msg.type) {
      case 'hello':
        link.hello = msg;
        return;
      case 'ready':
        link.ready = msg;
        return;
      case 'worker':
        if (!link.workers.has(msg.workerId) || msg.msg.workerId !== msg.workerId)
          return this.h.onLost(link.index, `worker ${msg.workerId} is not assigned to this agent`);
        return this.h.onWorker(link.index, msg.msg);
      case 'exit':
        if (!link.workers.has(msg.workerId))
          return this.h.onLost(link.index, `exit for unassigned worker ${msg.workerId}`);
        return this.h.onExit(link.index, msg.workerId, msg.forced, msg.code, msg.signal);
      case 'sample':
        return this.h.onSample(link.index, msg.sample);
      case 'abort':
        return this.h.onAbort(link.index, msg.reason);
      case 'bye':
        link.bye = msg;
        return;
      case 'heartbeat':
        return;
    }
  }

  private send(link: Link, msg: ControllerMessage): void {
    if (!link.ended) writeMessage(link.stdin, msg);
  }

  private async until(done: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = this.now() + timeoutMs;
    while (!done()) {
      if (this.now() > deadline) throw new Error(`timed out waiting for agent ${what}`);
      if (this.links.some((l) => l.ended)) throw new Error(`an agent ended before ${what}`);
      await sleep(50);
    }
  }
}

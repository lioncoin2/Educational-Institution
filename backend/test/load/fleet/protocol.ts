/**
 * P8.4 — the controller ⇄ agent wire protocol: one JSON object per line
 * (NDJSON) over the agent's stdio, carried by SSH for a remote generator or a
 * pipe for a local one. Worker events are relayed VERBATIM inside an envelope
 * (`WorkerMessage` from mp/types.ts is not redefined here).
 *
 * The controller treats agent input as UNTRUSTED: every line is size-capped
 * and structurally validated before it reaches any state; identity scoping is
 * enforced later by the controller (an agent may only report identities that
 * were minted to its own shards).
 */
import { type WorkerMessage, type WorkerParticipant } from '../mp/types';
import { type AbortReason, type HostSample } from '../observe/sample';

export const PROTOCOL_VERSION = 'p84-fleet/v1';
/** Longest accepted line (bytes); a longer line is a protocol error. */
export const MAX_LINE_BYTES = 256 * 1024;

export interface HostFacts {
  readonly hostname: string;
  readonly vcpu: number;
  readonly memTotalKb: number;
  readonly ipv4: readonly string[];
  readonly linkMbps: number | null;
}

/** One worker process the controller asks an agent to run. */
export interface WorkerSpec {
  /** Global shard index (unique across the fleet). */
  readonly workerId: number;
  readonly kind: 'publisher' | 'listeners';
  /** How many participants this worker will be admitted (its shard size). */
  readonly capacity: number;
  readonly probe: boolean;
}

export interface AssignSettings {
  readonly ice: { readonly mode: 'turn-free' } | { readonly mode: 'relay' };
  readonly teardownTimeoutMs: number;
  readonly shutdownGraceMs: number;
  readonly statsIntervalMs: number;
  readonly sampleIntervalMs: number;
  readonly heartbeatMs: number;
  readonly deadManMs: number;
  readonly publishRetries: number;
  /** The SUT address generators attribute flows to (T6/T7). */
  readonly sutAddress: string;
}

export type ControllerMessage =
  | {
      readonly type: 'assign';
      readonly runId: string;
      readonly rung: string;
      readonly agentIndex: number;
      readonly workers: readonly WorkerSpec[];
      readonly settings: AssignSettings;
    }
  | { readonly type: 'admit'; readonly workerId: number; readonly participant: WorkerParticipant }
  | { readonly type: 'shutdown'; readonly reason: string }
  | { readonly type: 'heartbeat'; readonly t: number };

export type AgentMessage =
  | {
      readonly type: 'hello';
      readonly protocol: string;
      readonly commit: string;
      readonly bundleSha256: string | null;
      readonly node: string;
      readonly host: HostFacts;
    }
  | { readonly type: 'ready'; readonly workers: number; readonly stunUrl: string | null }
  | { readonly type: 'worker'; readonly workerId: number; readonly msg: WorkerMessage }
  | {
      readonly type: 'exit';
      readonly workerId: number;
      readonly code: number | null;
      readonly signal: string | null;
      readonly forced: boolean;
    }
  | { readonly type: 'sample'; readonly sample: HostSample }
  | { readonly type: 'abort'; readonly reason: AbortReason }
  | { readonly type: 'heartbeat'; readonly t: number }
  /**
   * The agent's last word: how many worker processes it spawned and how many
   * were still alive after its bounded shutdown. Teardown classification is the
   * controller's (from the relayed worker events and exit records).
   */
  | { readonly type: 'bye'; readonly spawned: number; readonly liveChildren: number };

export type Decoded<T> =
  { readonly ok: true; readonly msg: T } | { readonly ok: false; readonly error: string };

/** One message as a single NDJSON line (with the trailing newline). */
export function encode(msg: ControllerMessage | AgentMessage): string {
  return `${JSON.stringify(msg)}\n`;
}

type Shape = Readonly<
  Record<string, 'string' | 'number' | 'boolean' | 'object' | 'nullable-string' | 'nullable-number'>
>;

const AGENT_SHAPES: Readonly<Record<AgentMessage['type'], Shape>> = {
  hello: {
    protocol: 'string',
    commit: 'string',
    bundleSha256: 'nullable-string',
    node: 'string',
    host: 'object',
  },
  ready: { workers: 'number', stunUrl: 'nullable-string' },
  worker: { workerId: 'number', msg: 'object' },
  exit: {
    workerId: 'number',
    code: 'nullable-number',
    signal: 'nullable-string',
    forced: 'boolean',
  },
  sample: { sample: 'object' },
  abort: { reason: 'object' },
  heartbeat: { t: 'number' },
  bye: { spawned: 'number', liveChildren: 'number' },
};

const CONTROLLER_SHAPES: Readonly<Record<ControllerMessage['type'], Shape>> = {
  assign: {
    runId: 'string',
    rung: 'string',
    agentIndex: 'number',
    workers: 'object',
    settings: 'object',
  },
  admit: { workerId: 'number', participant: 'object' },
  shutdown: { reason: 'string' },
  heartbeat: { t: 'number' },
};

function decodeWith<T>(line: string, shapes: Readonly<Record<string, Shape>>): Decoded<T> {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES)
    return { ok: false, error: 'line too long' };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { ok: false, error: 'not an object' };
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string' || !Object.hasOwn(shapes, type))
    return { ok: false, error: `unknown type ${String(type)}` };
  for (const [field, kind] of Object.entries(shapes[type] ?? {})) {
    const v = record[field];
    const ok =
      kind === 'nullable-string'
        ? v === null || typeof v === 'string'
        : kind === 'nullable-number'
          ? v === null || typeof v === 'number'
          : kind === 'object'
            ? typeof v === 'object' && v !== null
            : typeof v === kind;
    if (!ok) return { ok: false, error: `${type}.${field} must be ${kind}` };
  }
  if (type === 'worker' && !isWorkerMessage(record.msg))
    return { ok: false, error: 'worker.msg invalid' };
  return { ok: true, msg: value as T };
}

function isWorkerMessage(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m.type === 'string' && typeof m.workerId === 'number';
}

export function decodeAgentMessage(line: string): Decoded<AgentMessage> {
  return decodeWith<AgentMessage>(line, AGENT_SHAPES);
}

export function decodeControllerMessage(line: string): Decoded<ControllerMessage> {
  return decodeWith<ControllerMessage>(line, CONTROLLER_SHAPES);
}

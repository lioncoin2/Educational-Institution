import { once } from 'node:events';
import { PassThrough } from 'node:stream';

import { readLines, writeMessage } from '../fleet/channel';
import {
  type AgentMessage,
  type ControllerMessage,
  type Decoded,
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  decodeAgentMessage,
  decodeControllerMessage,
  encode,
} from '../fleet/protocol';
import { type WorkerMessage } from '../mp/types';
import { ABORT_SCHEMA, type HostSample, SAMPLE_SCHEMA } from '../observe/sample';

const SAMPLE: HostSample = {
  schema: SAMPLE_SCHEMA,
  runId: '0123456789abcdef',
  rung: 'S2',
  host: 'gen-1',
  role: 'generator',
  t: 5_000,
  seq: 1,
  clockOffsetMs: 0.4,
  cores: null,
  cpuClockMs: null,
  load1: null,
  mem: null,
  oomKills: null,
  net: null,
  qdisc: null,
  udp: { v4: null, v6: null },
  softnet: null,
  conntrack: null,
  udpSockets: null,
  procs: [],
  sut: null,
  gen: null,
};

/** One valid message of every agent → controller type. */
const AGENT: Readonly<Record<AgentMessage['type'], AgentMessage>> = {
  hello: {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    commit: 'abc1234',
    bundleSha256: null,
    node: 'v22.0.0',
    host: {
      hostname: 'gen-1',
      vcpu: 8,
      memTotalKb: 16_000_000,
      ipv4: ['10.0.0.2'],
      linkMbps: null,
    },
  },
  ready: { type: 'ready', workers: 2, stunUrl: 'stun:10.0.0.2:3478' },
  worker: {
    type: 'worker',
    workerId: 3,
    msg: { type: 'connected', workerId: 3, participantId: 'p84-01234567-L00001', role: 'listener' },
  },
  exit: { type: 'exit', workerId: 3, code: 0, signal: null, forced: false },
  sample: { type: 'sample', sample: SAMPLE },
  abort: {
    type: 'abort',
    reason: {
      schema: ABORT_SCHEMA,
      runId: '0123456789abcdef',
      rung: 'S2',
      at: 5_000,
      source: 'gen-watchdog:gen-1',
      rule: 'G-lag',
      observed: { value: 250, unit: 'ms', samples: [250, 250, 250, 250] },
      threshold: { op: '>', value: 200, sustain: '4 consecutive samples' },
      classHint: 'A',
      validity: true,
      detail: 'G-lag > 200 (4 consecutive samples)',
    },
  },
  heartbeat: { type: 'heartbeat', t: 1 },
  bye: { type: 'bye', spawned: 2, liveChildren: 0 },
};

/** One valid message of every controller → agent type. */
const CONTROLLER: Readonly<Record<ControllerMessage['type'], ControllerMessage>> = {
  assign: {
    type: 'assign',
    runId: '0123456789abcdef',
    rung: 'S2',
    agentIndex: 0,
    workers: [{ workerId: 0, kind: 'publisher', capacity: 1, probe: false }],
    settings: {
      ice: { mode: 'turn-free' },
      teardownTimeoutMs: 2_000,
      shutdownGraceMs: 4_000,
      statsIntervalMs: 5_000,
      sampleIntervalMs: 5_000,
      heartbeatMs: 2_000,
      deadManMs: 10_000,
      publishRetries: 0,
      sutAddress: '213.136.65.135',
    },
  },
  admit: {
    type: 'admit',
    workerId: 1,
    participant: {
      identity: 'p84-01234567-L00000',
      room: 'loadtest-p84-0123456789abcdef',
      role: 'listener',
      ticket: { url: 'wss://sfu.example', token: 'jwt' },
    },
  },
  shutdown: { type: 'shutdown', reason: 'complete' },
  heartbeat: { type: 'heartbeat', t: 2 },
};

/** `base` with fields replaced (undefined = removed), as one JSON line. */
const lineOf = (base: object, patch: Record<string, unknown>): string =>
  JSON.stringify({ ...base, ...patch });

/** A valid heartbeat line padded with JSON whitespace to exactly `bytes` bytes. */
const paddedHeartbeat = (bytes: number): string => {
  const line = '{"type":"heartbeat","t":1}';
  return line + ' '.repeat(bytes - line.length);
};

describe('fleet/protocol — encode', () => {
  it('writes one JSON object per line, newline-terminated, with embedded newlines escaped', () => {
    const line = encode({ type: 'shutdown', reason: 'abort:\nS-oom' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
    expect(JSON.parse(line)).toEqual({ type: 'shutdown', reason: 'abort:\nS-oom' });
  });

  it.each(Object.values(AGENT))('round-trips the agent message $type', (msg) => {
    expect(decodeAgentMessage(encode(msg).slice(0, -1))).toEqual({ ok: true, msg });
  });

  it.each(Object.values(CONTROLLER))('round-trips the controller message $type', (msg) => {
    expect(decodeControllerMessage(encode(msg).slice(0, -1))).toEqual({ ok: true, msg });
  });
});

describe('fleet/protocol — refused lines', () => {
  it.each(['', 'nope', '{"type":', "{'type':'heartbeat'}"])('refuses non-JSON %j', (line) => {
    expect(decodeAgentMessage(line)).toEqual({ ok: false, error: 'not JSON' });
    expect(decodeControllerMessage(line)).toEqual({ ok: false, error: 'not JSON' });
  });

  it.each(['[]', '[{"type":"heartbeat","t":1}]', 'null', '42', '"heartbeat"', 'true'])(
    'refuses a JSON value that is not an object: %s',
    (line) => {
      expect(decodeAgentMessage(line)).toEqual({ ok: false, error: 'not an object' });
      expect(decodeControllerMessage(line)).toEqual({ ok: false, error: 'not an object' });
    },
  );

  it.each([
    ['{}', 'unknown type undefined'],
    ['{"type":5}', 'unknown type 5'],
    ['{"type":null}', 'unknown type null'],
    ['{"type":"nope"}', 'unknown type nope'],
    ['{"type":"__proto__"}', 'unknown type __proto__'],
    ['{"type":"toString"}', 'unknown type toString'],
    ['{"type":"constructor"}', 'unknown type constructor'],
  ])('refuses an unknown type: %s', (line, error) => {
    expect(decodeAgentMessage(line)).toEqual({ ok: false, error });
    expect(decodeControllerMessage(line)).toEqual({ ok: false, error });
  });

  it('accepts each direction only its own types (heartbeat goes both ways)', () => {
    for (const msg of Object.values(CONTROLLER).filter((m) => m.type !== 'heartbeat'))
      expect(decodeAgentMessage(JSON.stringify(msg))).toEqual({
        ok: false,
        error: `unknown type ${msg.type}`,
      });
    for (const msg of Object.values(AGENT).filter((m) => m.type !== 'heartbeat'))
      expect(decodeControllerMessage(JSON.stringify(msg))).toEqual({
        ok: false,
        error: `unknown type ${msg.type}`,
      });
    expect(decodeAgentMessage('{"type":"heartbeat","t":1}').ok).toBe(true);
    expect(decodeControllerMessage('{"type":"heartbeat","t":1}').ok).toBe(true);
  });
});

describe('fleet/protocol — field types', () => {
  it.each([
    ['hello', { protocol: 1 }, 'hello.protocol must be string'],
    ['hello', { commit: undefined }, 'hello.commit must be string'],
    ['hello', { bundleSha256: 7 }, 'hello.bundleSha256 must be nullable-string'],
    ['hello', { bundleSha256: undefined }, 'hello.bundleSha256 must be nullable-string'],
    ['hello', { host: null }, 'hello.host must be object'],
    ['hello', { host: 'gen-1' }, 'hello.host must be object'],
    ['ready', { workers: '2' }, 'ready.workers must be number'],
    ['ready', { stunUrl: 3478 }, 'ready.stunUrl must be nullable-string'],
    ['ready', { stunUrl: undefined }, 'ready.stunUrl must be nullable-string'],
    ['worker', { workerId: '3' }, 'worker.workerId must be number'],
    ['exit', { workerId: null }, 'exit.workerId must be number'],
    ['exit', { forced: 'false' }, 'exit.forced must be boolean'],
    ['sample', { sample: null }, 'sample.sample must be object'],
    ['abort', { reason: 'G-lag' }, 'abort.reason must be object'],
    ['heartbeat', { t: '1' }, 'heartbeat.t must be number'],
    ['bye', { spawned: undefined }, 'bye.spawned must be number'],
    ['bye', { liveChildren: null }, 'bye.liveChildren must be number'],
  ] as const)('agent %s with %j: %s', (type, patch, error) => {
    expect(decodeAgentMessage(lineOf(AGENT[type], patch))).toEqual({ ok: false, error });
  });

  it.each([
    ['assign', { runId: 1 }, 'assign.runId must be string'],
    ['assign', { agentIndex: '0' }, 'assign.agentIndex must be number'],
    ['assign', { workers: 'all' }, 'assign.workers must be object'],
    ['assign', { settings: null }, 'assign.settings must be object'],
    ['admit', { workerId: '1' }, 'admit.workerId must be number'],
    ['admit', { participant: null }, 'admit.participant must be object'],
    ['shutdown', { reason: undefined }, 'shutdown.reason must be string'],
    ['heartbeat', { t: null }, 'heartbeat.t must be number'],
  ] as const)('controller %s with %j: %s', (type, patch, error) => {
    expect(decodeControllerMessage(lineOf(CONTROLLER[type], patch))).toEqual({ ok: false, error });
  });

  it('accepts null or a string in nullable fields', () => {
    for (const bundleSha256 of [null, 'a'.repeat(64)])
      expect(decodeAgentMessage(lineOf(AGENT.hello, { bundleSha256 })).ok).toBe(true);
    for (const stunUrl of [null, 'stun:10.0.0.2:3478'])
      expect(decodeAgentMessage(lineOf(AGENT.ready, { stunUrl })).ok).toBe(true);
  });

  it('exit: refuses a code that is not a number or null and a signal that is not a string or null', () => {
    // AgentMessage['exit'] declares `code: number | null` and `signal: string | null`, and the
    // controller feeds both into teardown classification (MpAggregator.recordExit).
    const malformed = [
      { code: '0' },
      { code: undefined },
      { signal: 9 },
      { signal: undefined },
    ].filter((patch) => decodeAgentMessage(lineOf(AGENT.exit, patch)).ok);
    expect(malformed).toEqual([]);
  });
});

describe('fleet/protocol — the worker envelope', () => {
  it.each([{}, { type: 'connected' }, { workerId: 3 }, { type: 1, workerId: 3 }, [], [3]])(
    'refuses a relayed worker event without a string type and a numeric workerId: %j',
    (msg) => {
      expect(decodeAgentMessage(lineOf(AGENT.worker, { msg }))).toEqual({
        ok: false,
        error: 'worker.msg invalid',
      });
    },
  );

  it('refuses a worker event with a string workerId', () => {
    const msg = { type: 'connected', workerId: '3', participantId: 'x', role: 'listener' };
    expect(decodeAgentMessage(lineOf(AGENT.worker, { msg }))).toEqual({
      ok: false,
      error: 'worker.msg invalid',
    });
  });

  it.each([null, 'connected', 3])('refuses a non-object worker event: %j', (msg) => {
    expect(decodeAgentMessage(lineOf(AGENT.worker, { msg }))).toEqual({
      ok: false,
      error: 'worker.msg must be object',
    });
  });

  it('relays a well-formed worker event verbatim, payload included', () => {
    const msg: WorkerMessage = {
      type: 'mediaWindow',
      workerId: 3,
      window: {
        t: 5_000,
        listeners: 10,
        subscribed: 10,
        receiving: 10,
        stalled: 0,
        gaps: 0,
        packetsReceived: 500,
        packetsLost: 1,
        lossBands: { green: 10, yellow: 0, red: 0 },
        jitterMsMax: 3.5,
        loopLagMsP95: 4,
      },
    };
    expect(decodeAgentMessage(lineOf(AGENT.worker, { msg }))).toEqual({
      ok: true,
      msg: { ...AGENT.worker, msg },
    });
  });
});

describe('fleet/protocol — line size cap', () => {
  it('accepts a line of exactly MAX_LINE_BYTES and refuses one byte more', () => {
    expect(decodeAgentMessage(paddedHeartbeat(MAX_LINE_BYTES))).toEqual({
      ok: true,
      msg: { type: 'heartbeat', t: 1 },
    });
    expect(decodeAgentMessage(paddedHeartbeat(MAX_LINE_BYTES + 1))).toEqual({
      ok: false,
      error: 'line too long',
    });
    expect(decodeControllerMessage(paddedHeartbeat(MAX_LINE_BYTES + 1))).toEqual({
      ok: false,
      error: 'line too long',
    });
  });

  it('counts UTF-8 bytes, not characters', () => {
    const reason = 'é'.repeat(MAX_LINE_BYTES / 2 + 1); // 2 bytes each
    const line = JSON.stringify({ type: 'shutdown', reason });
    expect(line.length).toBeLessThan(MAX_LINE_BYTES);
    expect(decodeControllerMessage(line)).toEqual({ ok: false, error: 'line too long' });
  });

  it('refuses an over-cap line before parsing it', () => {
    expect(decodeAgentMessage('x'.repeat(MAX_LINE_BYTES + 1))).toEqual({
      ok: false,
      error: 'line too long',
    });
  });
});

interface Got<T> {
  readonly messages: T[];
  readonly errors: string[];
  ends: number;
}

function reader<T>(
  stream: PassThrough,
  decode: (line: string) => Decoded<T>,
  maxBytes?: number,
): Got<T> {
  const got: Got<T> = { messages: [], errors: [], ends: 0 };
  readLines(
    stream,
    decode,
    {
      onMessage: (msg) => got.messages.push(msg),
      onProtocolError: (error) => got.errors.push(error),
      onEnd: () => {
        got.ends += 1;
      },
    },
    maxBytes,
  );
  return got;
}

/** Lets the stream deliver everything written so far. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function write(
  stream: PassThrough,
  ...chunks: ReadonlyArray<string | Buffer>
): Promise<void> {
  for (const chunk of chunks) {
    stream.write(chunk);
    await settle();
  }
}

describe('fleet/channel — readLines framing', () => {
  it('reassembles a message split across chunks', async () => {
    const stream = new PassThrough();
    const got = reader(stream, decodeAgentMessage);
    const line = encode(AGENT.hello);
    await write(stream, line.slice(0, 10), line.slice(10, 40));
    expect(got.messages).toEqual([]);
    await write(stream, line.slice(40));
    expect(got).toEqual({ messages: [AGENT.hello], errors: [], ends: 0 });
  });

  it('reassembles a multi-byte character split across chunks', async () => {
    const stream = new PassThrough();
    const got = reader(stream, decodeControllerMessage);
    const msg: ControllerMessage = { type: 'shutdown', reason: 'abort: café ✓' };
    const bytes = Buffer.from(encode(msg));
    const cut = bytes.indexOf(Buffer.from('é')) + 1; // between the two bytes of é
    await write(stream, bytes.subarray(0, cut), bytes.subarray(cut));
    expect(got.messages).toEqual([msg]);
    expect(got.errors).toEqual([]);
  });

  it('delivers several messages from one chunk, in order', async () => {
    const stream = new PassThrough();
    const got = reader(stream, decodeAgentMessage);
    await write(stream, encode(AGENT.ready) + encode(AGENT.worker) + encode(AGENT.heartbeat));
    expect(got.messages).toEqual([AGENT.ready, AGENT.worker, AGENT.heartbeat]);
  });

  it('ignores blank and whitespace-only lines', async () => {
    const stream = new PassThrough();
    const got = reader(stream, decodeAgentMessage);
    await write(stream, '\n \n\t\r\n', encode(AGENT.bye), '\n\n');
    expect(got).toEqual({ messages: [AGENT.bye], errors: [], ends: 0 });
  });

  it('reports protocol errors instead of throwing, and keeps reading', async () => {
    const stream = new PassThrough();
    const got = reader(stream, decodeAgentMessage);
    await write(stream, 'not json\n[1]\n{"type":"nope"}\n', encode(AGENT.heartbeat));
    expect(got.errors).toEqual(['not JSON', 'not an object', 'unknown type nope']);
    expect(got.messages).toEqual([AGENT.heartbeat]);
  });

  it('reports an over-cap partial line once, then ignores the rest of the stream', async () => {
    const stream = new PassThrough();
    const got = reader(stream, decodeAgentMessage, 64);
    await write(stream, 'x'.repeat(40));
    expect(got.errors).toEqual([]);
    await write(stream, 'x'.repeat(40)); // 80 bytes buffered without a newline
    expect(got.errors).toEqual(['line too long']);
    await write(stream, `\n${encode(AGENT.heartbeat)}`, 'y'.repeat(100), `\n${encode(AGENT.bye)}`);
    expect(got.messages).toEqual([]);
    expect(got.errors).toEqual(['line too long']);
    const closed = once(stream, 'close');
    stream.end();
    await closed;
    expect(got.ends).toBe(1);
  });

  it('a partial line of exactly maxBytes is not over the cap', async () => {
    const stream = new PassThrough();
    const got = reader(stream, decodeAgentMessage, 64);
    await write(stream, paddedHeartbeat(64));
    expect(got.errors).toEqual([]);
    await write(stream, '\n');
    expect(got.messages).toEqual([{ type: 'heartbeat', t: 1 }]);
  });

  it('enforces MAX_LINE_BYTES by default', async () => {
    const stream = new PassThrough();
    const got = reader(stream, decodeAgentMessage);
    await write(stream, 'x'.repeat(MAX_LINE_BYTES + 1));
    expect(got.errors).toEqual(['line too long']);
    expect(got.messages).toEqual([]);
  });

  it('refuses a complete over-cap line too', async () => {
    const stream = new PassThrough();
    const got = reader(stream, decodeAgentMessage);
    await write(stream, `${paddedHeartbeat(MAX_LINE_BYTES + 1)}\n`);
    expect(got.errors).toEqual(['line too long']);
    expect(got.messages).toEqual([]);
  });
});

describe('fleet/channel — readLines end of stream', () => {
  it('calls onEnd exactly once when both end and close fire', async () => {
    const stream = new PassThrough();
    const got = reader(stream, decodeAgentMessage);
    const seen: string[] = [];
    stream.on('end', () => seen.push('end'));
    stream.on('close', () => seen.push('close'));
    const closed = once(stream, 'close');
    stream.end(encode(AGENT.bye));
    await closed;
    await settle();
    expect(seen).toEqual(['end', 'close']);
    expect(got).toEqual({ messages: [AGENT.bye], errors: [], ends: 1 });
  });

  it('a read error ends the link once and is never thrown', async () => {
    const stream = new PassThrough();
    const got = reader(stream, decodeAgentMessage);
    // (events.once would itself reject on the 'error' event, so wait for 'close' directly)
    const closed = new Promise((resolve) => stream.on('close', resolve));
    stream.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await closed;
    await settle();
    expect(got.ends).toBe(1);
  });

  it('calls onEnd once when the stream is destroyed without ending', async () => {
    const stream = new PassThrough();
    const got = reader(stream, decodeAgentMessage);
    const closed = once(stream, 'close');
    stream.destroy();
    await closed;
    await settle();
    expect(got.ends).toBe(1);
  });
});

describe('fleet/channel — writeMessage', () => {
  it('writes the message as one encoded line and returns true while the stream is open', async () => {
    const stream = new PassThrough();
    const got = reader(stream, decodeControllerMessage);
    expect(writeMessage(stream, CONTROLLER.admit)).toBe(true);
    expect(writeMessage(stream, CONTROLLER.heartbeat)).toBe(true);
    await settle();
    expect(got.messages).toEqual([CONTROLLER.admit, CONTROLLER.heartbeat]);
  });

  it('returns false, without writing or throwing, on a destroyed stream', () => {
    const stream = new PassThrough();
    stream.destroy();
    const spy = jest.spyOn(stream, 'write');
    expect(writeMessage(stream, CONTROLLER.shutdown)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns false, without writing, on an ended stream', () => {
    const stream = new PassThrough();
    stream.end();
    const spy = jest.spyOn(stream, 'write');
    expect(writeMessage(stream, CONTROLLER.shutdown)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

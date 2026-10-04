import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent, type AgentDeps } from '../fleet/agent';
import { AGENT_MAIN } from '../fleet/endpoints';
import { type AgentMessage, type AssignSettings, PROTOCOL_VERSION } from '../fleet/protocol';
import { ProcessManager, childEnv } from '../mp/process-manager';
import { type HostSample, SAMPLE_SCHEMA } from '../observe/sample';

/**
 * Unit tests for the generator AGENT's own lifecycle with fake dependencies (no
 * worker processes): hello, assignment, the in-process STUN responder, the
 * generator watchdog's abort, the dead-man timeout and the single stop path.
 */
const SETTINGS: AssignSettings = {
  ice: { mode: 'turn-free' },
  teardownTimeoutMs: 200,
  shutdownGraceMs: 500,
  statsIntervalMs: 100,
  sampleIntervalMs: 50,
  heartbeatMs: 20,
  deadManMs: 150,
  publishRetries: 0,
  sutAddress: '127.0.0.1',
};

function sample(unexplained: number): HostSample {
  return {
    schema: SAMPLE_SCHEMA,
    runId: '0123456789abcdef',
    rung: 'S1',
    host: 'gen-test',
    role: 'generator',
    t: Date.now(),
    seq: 1,
    clockOffsetMs: 0.1,
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
    gen: {
      participants: 0,
      flowsToSut3478: 0,
      tcpToSut443: 0,
      linkMbps: 1000,
      processGroup: { members: 1 + unexplained, workers: 0, helpers: 0, unexplained },
    },
  };
}

function harness(unexplained = 0) {
  const sent: AgentMessage[] = [];
  const exits: number[] = [];
  let stunClosed = 0;
  const deps: AgentDeps = {
    send: (m) => sent.push(m),
    pm: new ProcessManager(),
    sample: async () => sample(unexplained),
    startStun: async () => ({
      url: 'stun:127.0.0.1:3479',
      close: async () => {
        stunClosed += 1;
      },
    }),
    record: async () => undefined,
    now: Date.now,
    exit: (code) => exits.push(code),
  };
  const agent = new Agent(
    {
      runId: '0123456789abcdef',
      commit: 'abc',
      bundleSha256: null,
      workerModule: '/nonexistent.ts',
      host: {
        hostname: 'gen-test',
        vcpu: 2,
        memTotalKb: 1,
        ipv4: ['198.51.100.7'],
        linkMbps: null,
      },
    },
    deps,
  );
  return { agent, sent, exits, stunClosed: () => stunClosed };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const types = (sent: AgentMessage[]): string[] => sent.map((m) => m.type);

describe('generator agent', () => {
  it('says hello with the protocol version and its commit', () => {
    const { agent, sent } = harness();
    agent.start();
    expect(sent[0]).toMatchObject({ type: 'hello', protocol: PROTOCOL_VERSION, commit: 'abc' });
  });

  it('on assign starts the STUN responder (TURN-free) and reports ready with its URL', async () => {
    const { agent, sent } = harness();
    agent.handle({
      type: 'assign',
      runId: '0123456789abcdef',
      rung: 'S1',
      agentIndex: 0,
      workers: [],
      settings: SETTINGS,
    });
    await sleep(30);
    expect(sent.find((m) => m.type === 'ready')).toEqual({
      type: 'ready',
      workers: 0,
      stunUrl: 'stun:127.0.0.1:3479',
    });
    agent.handle({ type: 'shutdown', reason: 'test' });
    await sleep(50);
  });

  it('an unexplained process in its group fires the generator watchdog (abort, class A, validity)', async () => {
    const { agent, sent } = harness(1);
    agent.handle({
      type: 'assign',
      runId: '0123456789abcdef',
      rung: 'S1',
      agentIndex: 0,
      workers: [],
      settings: SETTINGS,
    });
    for (let t = 0; t < 10 && !sent.some((m) => m.type === 'abort'); t += 1) {
      agent.handle({ type: 'heartbeat', t: Date.now() });
      await sleep(40);
    }
    const abort = sent.find((m) => m.type === 'abort');
    expect(abort).toMatchObject({
      type: 'abort',
      reason: { rule: 'G-proc', classHint: 'A', validity: true },
    });
    agent.handle({ type: 'shutdown', reason: 'test' });
    await sleep(50);
  });

  it('the dead-man stops it once: bye then exit(0), STUN closed', async () => {
    const h = harness();
    h.agent.handle({
      type: 'assign',
      runId: '0123456789abcdef',
      rung: 'S1',
      agentIndex: 0,
      workers: [],
      settings: SETTINGS,
    });
    await sleep(400); // > deadManMs with no controller message
    expect(types(h.sent).filter((t) => t === 'bye')).toHaveLength(1);
    expect(h.exits).toEqual([0]);
    expect(h.stunClosed()).toBe(1);
  });

  it('shutdown and a later stop() take the same single path', async () => {
    const h = harness();
    h.agent.handle({
      type: 'assign',
      runId: '0123456789abcdef',
      rung: 'S1',
      agentIndex: 0,
      workers: [],
      settings: SETTINGS,
    });
    await sleep(20);
    h.agent.handle({ type: 'shutdown', reason: 'complete' });
    await h.agent.stop();
    await sleep(20);
    expect(types(h.sent).filter((t) => t === 'bye')).toHaveLength(1);
    expect(h.exits).toEqual([0]);
  });
});

describe('fleet/agent-main — the controller end of the pipe is gone', () => {
  it('regression: EPIPE on stdout stops the agent through its bounded path (exit 0), never a crash', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'p84-epipe-'));
    try {
      const child = spawn(
        process.execPath,
        [
          '-r',
          'ts-node/register/transpile-only',
          AGENT_MAIN,
          '--run',
          '0123456789abcdef',
          '--runs-dir',
          runsDir,
          '--local',
          '--worker-module',
          join(__dirname, '..', 'mp', 'fake-worker.ts'),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(process.env) },
      );
      child.stdout.destroy(); // the agent's first write (hello) now fails with EPIPE
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      // stdin stays open and no assign is sent, so nothing but the EPIPE path can stop it.
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      expect(stderr).not.toMatch(/EPIPE|Unhandled 'error' event/);
      expect(code).toBe(0);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  }, 60_000);
});

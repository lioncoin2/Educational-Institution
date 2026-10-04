/**
 * P8.4 — the agent process entry (design §3). Started by `p84-dispatch agent
 * <runId>` over the controller's SSH session (or as a local child in tests):
 * NDJSON from the controller on stdin, NDJSON to the controller on stdout —
 * stdout carries ONLY protocol lines; diagnostics go to stderr.
 *
 *   agent-main.ts --run <runId> --runs-dir <dir> [--local --worker-module <path>] [--iface eth0]
 *   agent-main.ts --stop <runId> --runs-dir <dir>   (signals only the PIDs recorded for that run)
 *
 * stdin EOF (the controller or SSH died), SIGTERM, SIGINT and SIGHUP all take
 * the agent's single stop path.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { cpus, hostname, networkInterfaces, totalmem } from 'node:os';
import { join } from 'node:path';

import { Agent } from './agent';
import { readLines, writeMessage } from './channel';
import { type HostFacts, decodeControllerMessage } from './protocol';
import { defaultProcProbe, readRunFile, signalRecorded, writeRunFile } from './run-registry';
import { StunResponder } from './stun';
import { ProcessManager } from '../mp/process-manager';
import { parsePidStat } from '../metrics/procfs';
import { parseDefaultRouteIface, systemReaders } from '../observe/host-base';
import { quietReaders } from '../observe/quiet-readers';
import { HostSampler } from '../observe/host-sampler';

const STUN_PORT = 3479;

function flag(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

function publicIpv4(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

function hostFacts(): HostFacts {
  return {
    hostname: hostname(),
    vcpu: cpus().length,
    memTotalKb: Math.round(totalmem() / 1024),
    ipv4: publicIpv4(),
    linkMbps: null,
  };
}

/** The installed bundle's hash, from `/opt/p84/versions/<sha256>/repo` (null when local). */
function bundleSha256(): string | null {
  return /\/versions\/([0-9a-f]{64})\//.exec(`${realpathSync(process.cwd())}/`)?.[1] ?? null;
}

function commit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function starttime(pid: number): number {
  return parsePidStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.starttime ?? 0;
}

async function stopRun(runsDir: string, runId: string): Promise<void> {
  const file = await readRunFile(runsDir, runId);
  if (!file) throw new Error(`no run file for ${runId}`);
  const outcome = await signalRecorded(file, 'SIGTERM', defaultProcProbe());
  process.stderr.write(`stop ${runId}: ${JSON.stringify(outcome)}\n`);
}

function runAgent(argv: readonly string[], runId: string, runsDir: string): void {
  const local = argv.includes('--local');
  // The generator's NIC is whatever carries its default route (VMs rarely say eth0).
  const route = (() => {
    try {
      return parseDefaultRouteIface(readFileSync('/proc/net/route', 'utf8'));
    } catch {
      return null;
    }
  })();
  const iface = flag(argv, 'iface') ?? route ?? 'eth0';
  const facts = hostFacts();
  // --local is TEST-ONLY (fake driver): a quiet, complete host whose per-process reads stay real.
  const readers = local
    ? quietReaders(systemReaders(), { role: 'generator', iface })
    : systemReaders();
  let sampler: { key: string; s: HostSampler } | null = null;
  const send = (msg: Parameters<typeof writeMessage>[1]): void =>
    void writeMessage(process.stdout, msg);
  const pm = new ProcessManager((p, rec) =>
    send({ type: 'exit', workerId: p.id, code: rec.code, signal: rec.signal, forced: rec.forced }),
  );
  const agent: Agent = new Agent(
    {
      runId,
      commit: commit(),
      bundleSha256: bundleSha256(),
      workerModule: flag(argv, 'worker-module') ?? join(__dirname, '..', 'mp', 'worker.ts'),
      host: facts,
    },
    {
      send,
      pm,
      sample: (procs, participants, ctx) => {
        const key = `${ctx.rung}|${ctx.sutAddress}`;
        if (sampler?.key !== key)
          sampler = {
            key,
            s: new HostSampler(readers, {
              runId,
              rung: ctx.rung,
              host: facts.hostname,
              iface,
              sutAddress: ctx.sutAddress,
            }),
          };
        return sampler.s.sample(procs, participants);
      },
      startStun: async () => {
        const responder = new StunResponder({
          port: local ? 0 : STUN_PORT,
          host: local ? '127.0.0.1' : '0.0.0.0',
        });
        const { port } = await responder.start();
        const address = local ? '127.0.0.1' : (facts.ipv4[0] ?? '127.0.0.1');
        return { url: `stun:${address}:${port}`, close: () => responder.close() };
      },
      record: (children) =>
        writeRunFile(runsDir, {
          runId,
          agent: {
            pid: process.pid,
            pgid: parsePidStat(readFileSync('/proc/self/stat', 'utf8'))?.pgrp ?? 0,
            starttime: starttime(process.pid),
          },
          children: children.map((c) => ({
            pid: c.pid,
            starttime: starttime(c.pid),
            label: c.label,
          })),
        }),
      now: Date.now,
      exit: (code) => process.exit(code),
    },
  );
  const stop = (): void => void agent.stop();
  // The controller's end of the pipe is gone (EPIPE on stdout): the same bounded stop, never a crash.
  process.stdout.on('error', stop);
  readLines(process.stdin, decodeControllerMessage, {
    onMessage: (msg) => agent.handle(msg),
    onProtocolError: (error) => {
      process.stderr.write(`agent: protocol error: ${error}\n`);
      stop();
    },
    onEnd: stop,
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, stop);
  agent.start();
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const runsDir = flag(argv, 'runs-dir');
  const stopId = flag(argv, 'stop');
  const runId = flag(argv, 'run');
  if (!runsDir || (!stopId && !runId)) {
    process.stderr.write(
      'usage: agent-main --run <runId> --runs-dir <dir> | --stop <runId> --runs-dir <dir>\n',
    );
    process.exit(64);
  }
  if (stopId)
    void stopRun(runsDir, stopId).then(
      () => process.exit(0),
      (e: unknown) => {
        process.stderr.write(`${String((e as Error)?.message ?? e)}\n`);
        process.exit(1);
      },
    );
  else runAgent(argv, runId ?? '', runsDir);
}

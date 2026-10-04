/**
 * P8.4 — the per-run PID registry on a generator (design §0 invariant 5, §20).
 * The agent records every process it owns in `<runsDir>/<runId>/pids.json`;
 * the emergency `stop <runId>` (p84-dispatch) signals ONLY those PIDs, and
 * only while each is still the process that was recorded: its
 * /proc/<pid>/stat starttime must equal the recorded one, so a reused PID is
 * never signalled. No pgrep/pkill, no process-group kills, and nothing in the
 * caller's own process group.
 *
 * I/O stays at the edges (the file, the /proc probe); the signalling policy is
 * pure over an injected `ProcProbe`.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type PidStat, parsePidStat } from '../metrics/procfs';

const RUN_ID = /^[0-9a-f]{16}$/;
const PIDS_FILE = 'pids.json';

export interface RunFile {
  readonly runId: string;
  /** The agent itself; its children are forked into its process group (never detached). */
  readonly agent: { readonly pid: number; readonly pgid: number; readonly starttime: number };
  readonly children: ReadonlyArray<{
    readonly pid: number;
    readonly starttime: number;
    /** e.g. `worker:12`. */
    readonly label: string;
  }>;
}

/** The OS as `signalRecorded` sees it; `defaultProcProbe()` is the real one. */
export interface ProcProbe {
  /** Field 22 of /proc/<pid>/stat (clock ticks after boot), or null when no such process. */
  starttime(pid: number): Promise<number | null>;
  ownPgid(): number;
  kill(pid: number, signal: NodeJS.Signals): void;
}

export interface SignalReport {
  signalled: number[];
  skipped: Array<{ pid: number; reason: string }>;
}

/** `<runsDir>/<runId>`; throws unless runId is 16 lowercase hex digits. */
export function runDir(runsDir: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`invalid runId ${JSON.stringify(runId)}`);
  return join(runsDir, runId);
}

/** Atomically (temp file + rename) writes the run's pids.json; the run dir is private (0700). */
export async function writeRunFile(runsDir: string, file: RunFile): Promise<void> {
  const dir = runDir(runsDir, file.runId);
  if (!isRunFile(file)) throw new Error(`invalid run file for ${dir}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, PIDS_FILE);
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(file)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/** The run's recorded processes, or null when it has no pids.json; a malformed file throws. */
export async function readRunFile(runsDir: string, runId: string): Promise<RunFile | null> {
  const path = join(runDir(runsDir, runId), PIDS_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    file = null;
  }
  if (!isRunFile(file) || file.runId !== runId) throw new Error(`malformed ${path}`);
  return file;
}

/**
 * Sends `signal` to the recorded children, then to the agent — each only while
 * it is still the recorded process (starttime unchanged). When the agent's
 * group (which its children share) is the caller's own, nothing is signalled.
 * One process never stops the rest: a failed probe or kill is reported as
 * skipped. Throws only if the caller's own group is unknown (fail closed).
 */
export async function signalRecorded(
  file: RunFile,
  signal: NodeJS.Signals,
  probe: ProcProbe,
): Promise<SignalReport> {
  const report: SignalReport = { signalled: [], skipped: [] };
  const ownGroup = file.agent.pgid === probe.ownPgid();
  for (const { pid, starttime } of [...file.children, file.agent]) {
    const reason = ownGroup
      ? 'same process group as the caller'
      : await signalOne(pid, starttime, signal, probe);
    if (reason === null) report.signalled.push(pid);
    else report.skipped.push({ pid, reason });
  }
  return report;
}

/** Signals `pid` if it is still the recorded process; otherwise says why not. */
async function signalOne(
  pid: number,
  recorded: number,
  signal: NodeJS.Signals,
  probe: ProcProbe,
): Promise<string | null> {
  // 0, negative PIDs and 1 address a process group or init, never one recorded process.
  if (!isPid(pid)) return 'invalid pid';
  try {
    const current = await probe.starttime(pid);
    if (current === null) return 'not running';
    if (current !== recorded) return `pid reused (starttime ${current}, recorded ${recorded})`;
    probe.kill(pid, signal);
    return null;
  } catch (err) {
    return `failed: ${describeError(err)}`;
  }
}

/** The errno code when there is one (`ESRCH`, `EPERM`), else the message. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return (err as NodeJS.ErrnoException).code ?? err.message;
}

/** The real probe: /proc/<pid>/stat (metrics/procfs.ts parser) and process.kill. */
export function defaultProcProbe(): ProcProbe {
  return {
    async starttime(pid) {
      const path = `/proc/${pid}/stat`;
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ESRCH') return null;
        throw err;
      }
      return pidStat(text, path).starttime;
    },
    ownPgid() {
      return pidStat(readFileSync('/proc/self/stat', 'utf8'), '/proc/self/stat').pgrp;
    },
    kill(pid, signal) {
      process.kill(pid, signal);
    },
  };
}

function pidStat(text: string, path: string): PidStat {
  const stat = parsePidStat(text);
  if (stat === null) throw new Error(`unparsable ${path}`);
  return stat;
}

function isPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 1;
}

function isStarttime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRunFile(value: unknown): value is RunFile {
  if (typeof value !== 'object' || value === null) return false;
  const { runId, agent, children } = value as Record<string, unknown>;
  if (typeof runId !== 'string' || typeof agent !== 'object' || agent === null) return false;
  const a = agent as Record<string, unknown>;
  if (!isPid(a.pid) || !isPid(a.pgid) || !isStarttime(a.starttime)) return false;
  return (
    Array.isArray(children) &&
    children.every((child: unknown) => {
      if (typeof child !== 'object' || child === null) return false;
      const { pid, starttime, label } = child as Record<string, unknown>;
      return isPid(pid) && isStarttime(starttime) && typeof label === 'string';
    })
  );
}

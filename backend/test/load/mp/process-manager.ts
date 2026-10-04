/**
 * P8.4 — the single spawn primitive for every child process the harness owns:
 * worker processes (forked, IPC), a local agent and the `ssh` client that
 * carries a remote agent (spawned, NDJSON on stdio). Extracted from the
 * P8.3.8 supervisor so one owner records PIDs and exits, bounds shutdown, and
 * force-kills only the processes it spawned.
 *
 *  - Environment: an EXACT allowlist (`childEnv`) — nothing is inherited, so a
 *    credential in the parent's environment can never reach a child.
 *  - Shutdown: wait for every child's 'exit' event within a grace period;
 *    survivors are recorded as FORCED before SIGKILL, then awaited.
 *  - Never signals anything it did not spawn; never a process group.
 */
import { type ChildProcess, fork, spawn } from 'node:child_process';

/** The only variables a child inherits from its parent's environment. */
export const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'TZ'] as const;

/** An exact child environment: the allowlisted parent variables plus `extra`. */
export function childEnv(
  parent: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

export interface SpawnSpec {
  readonly label: string;
  /** `fork`: a Node module with an IPC channel; `exec`: a program with stdin/stdout pipes. */
  readonly mode: 'fork' | 'exec';
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly execArgv?: readonly string[];
  readonly cwd?: string;
}

export interface ExitRecord {
  readonly code: number | null;
  readonly signal: string | null;
  /** Still alive at the grace deadline and SIGKILLed by this manager. */
  readonly forced: boolean;
  /** Set when the process could not be started at all. */
  readonly error: string | null;
}

export interface OwnedProcess {
  readonly id: number;
  readonly label: string;
  readonly child: ChildProcess;
  readonly exited: Promise<ExitRecord>;
}

const FORCED_EXIT_WAIT_MS = 5_000;

/** Resolves true if `p` settles (fulfils or rejects) within `ms`; never leaves a timer behind. */
export async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const result = await Promise.race([
    p.then(
      () => true as const,
      () => true as const,
    ),
    late,
  ]);
  clearTimeout(timer);
  return result;
}

export class ProcessManager {
  private readonly owned = new Map<number, OwnedProcess>();
  private readonly forced = new Set<number>();

  constructor(private readonly onExit: (p: OwnedProcess, rec: ExitRecord) => void = () => {}) {}

  spawn(id: number, spec: SpawnSpec): OwnedProcess {
    if (this.owned.has(id)) throw new Error(`process ${id} is already owned`);
    const child =
      spec.mode === 'fork'
        ? fork(spec.command, [...spec.args], {
            execArgv: [...(spec.execArgv ?? [])],
            env: { ...spec.env },
            cwd: spec.cwd,
            stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
          })
        : spawn(spec.command, [...spec.args], {
            env: { ...spec.env },
            cwd: spec.cwd,
            stdio: ['pipe', 'pipe', 'inherit'],
            // Its own process group, so its process-group accounting (and the
            // generator's G-proc rule) never includes this parent's group.
            detached: true,
          });
    let settle: (rec: ExitRecord) => void = () => undefined;
    const exited = new Promise<ExitRecord>((resolve) => {
      settle = resolve;
    });
    const proc: OwnedProcess = { id, label: spec.label, child, exited };
    let done = false;
    const finish = (rec: ExitRecord): void => {
      if (done) return;
      done = true;
      this.onExit(proc, rec);
      settle(rec);
    };
    child.once('exit', (code, signal) =>
      finish({ code, signal, forced: this.forced.has(id), error: null }),
    );
    child.once('error', (err) => {
      // A process that never started emits 'error' without 'exit'.
      if (child.pid === undefined)
        finish({ code: null, signal: null, forced: false, error: err.message });
    });
    this.owned.set(id, proc);
    return proc;
  }

  get(id: number): OwnedProcess | undefined {
    return this.owned.get(id);
  }

  list(): OwnedProcess[] {
    return [...this.owned.values()];
  }

  /** Processes whose exit has not been observed yet. */
  alive(): OwnedProcess[] {
    return this.list().filter((p) => p.child.exitCode === null && p.child.signalCode === null);
  }

  /**
   * Waits for every owned process to EXIT (its 'exit' event, not merely "signal
   * sent") within `graceMs`. Survivors are recorded as forced BEFORE being
   * SIGKILLed, then awaited so their exit is accounted too.
   */
  async waitAllExited(graceMs: number): Promise<void> {
    const all = this.list();
    if (await settlesWithin(Promise.all(all.map((p) => p.exited)), graceMs)) return;
    const survivors = this.alive();
    for (const p of survivors) {
      this.forced.add(p.id);
      p.child.kill('SIGKILL');
    }
    await settlesWithin(Promise.all(survivors.map((p) => p.exited)), FORCED_EXIT_WAIT_MS);
  }
}

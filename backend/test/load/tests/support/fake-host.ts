/**
 * A fake host for the sampler specs: every read is answered from memory, never
 * from the machine running the test. quietReaders() decorates it exactly as it
 * decorates the real readers in the local fleet.
 */
import { type ProcStatRead, type Readers } from '../../observe/host-base';

export interface FakeProc {
  readonly comm: string;
  readonly ppid: number;
  readonly pgrp: number;
  readonly utime?: number;
  readonly stime?: number;
  readonly rssKb?: number;
  readonly threads?: number;
  /** Entries in /proc/<pid>/fd; null = unreadable. Default 10. */
  readonly fds?: number | null;
}

/** Two cores with fixed counters (a fake host that never idles between reads). */
const PROC_STAT =
  'cpu  300 0 150 2000 10 0 30 0 0 0\n' +
  'cpu0 200 0 100 1000 5 0 20 0 0 0\n' +
  'cpu1 100 0 50 1000 5 0 10 0 0 0\n' +
  'intr 1000\nctxt 2000\nbtime 1790000000\n';

/** A kernel command line with NO_HZ active (no `nohz=off`): the idle clock is exact. */
const CMDLINE = 'BOOT_IMAGE=/vmlinuz-6.8.0-146-generic root=/dev/sda1 ro\n';

/** The fake monotonic clock advances this much per /proc/stat read. */
export const FAKE_CLOCK_STEP_MS = 5_000;

/** /proc/<pid>/stat in the kernel's layout (fields after the comm: state ppid pgrp …). */
export const pidStat = (pid: number, p: FakeProc): string =>
  `${pid} (${p.comm}) S ${p.ppid} ${p.pgrp} ${p.pgrp} 0 -1 4194304 0 0 0 0 ` +
  `${p.utime ?? 0} ${p.stime ?? 0} 0 0 20 0 ${p.threads ?? 1} 0 100 1000000 500\n`;

const pidStatus = (p: FakeProc): string =>
  `Name:\t${p.comm}\nState:\tS (sleeping)\nVmRSS:\t   ${p.rssKb ?? 0} kB\nThreads:\t${p.threads ?? 1}\n`;

export class FakeHost implements Readers {
  readonly files = new Map<string, string>([
    ['/proc/stat', PROC_STAT],
    ['/proc/cmdline', CMDLINE],
  ]);
  /** The fake monotonic clock (ms) of the last /proc/stat read. */
  clockMs = 0;
  readonly commands = new Map<string, (args: readonly string[]) => string | null>();
  readonly procs = new Map<number, FakeProc>();
  /** The PID list; null = /proc unreadable; undefined = every fake process. */
  pidList: number[] | null | undefined = undefined;
  readonly fileReads: string[] = [];
  pidsCalls = 0;

  constructor(procs: Readonly<Record<number, FakeProc>> = {}) {
    for (const [pid, p] of Object.entries(procs)) this.procs.set(Number(pid), p);
  }

  readonly file = async (path: string): Promise<string | null> => {
    this.fileReads.push(path);
    const fixed = this.files.get(path);
    if (fixed !== undefined) return fixed;
    const m = /^\/proc\/(\d+)\/(stat|status)$/.exec(path);
    const p = m ? this.procs.get(Number(m[1])) : undefined;
    if (!m || !p) return null;
    return m[2] === 'stat' ? pidStat(Number(m[1]), p) : pidStatus(p);
  };

  readonly procStat = async (): Promise<ProcStatRead | null> => {
    const text = await this.file('/proc/stat');
    if (text === null) return null;
    this.clockMs += FAKE_CLOCK_STEP_MS;
    return { text, monoMs: this.clockMs };
  };

  readonly cmd = async (file: string, args: readonly string[]): Promise<string | null> =>
    this.commands.get(file)?.(args) ?? null;

  readonly fdCount = async (pid: number): Promise<number | null> => {
    const p = this.procs.get(pid);
    return p === undefined ? null : p.fds === undefined ? 10 : p.fds;
  };

  readonly pids = async (): Promise<number[] | null> => {
    this.pidsCalls += 1;
    return this.pidList === undefined ? [...this.procs.keys()] : this.pidList;
  };
}

/** Every reader fails. */
export const FAILING: Readers = {
  file: async () => null,
  procStat: async () => null,
  cmd: async () => null,
  fdCount: async () => null,
  pids: async () => null,
};

export interface Patch {
  /** Exact paths answered here (null = unreadable). */
  readonly files?: Readonly<Record<string, string | null>>;
  /** A command's answer (null = failed), or undefined to pass through. */
  readonly cmd?: (file: string, args: readonly string[]) => string | null | undefined;
}

/** `r` with some sources replaced or failing; records every command it is asked to run. */
export function patched(
  r: Readers,
  p: Patch,
  calls: Array<{ file: string; args: readonly string[] }> = [],
): Readers {
  return {
    file: async (path) => {
      const files = p.files ?? {};
      return path in files ? (files[path] ?? null) : r.file(path);
    },
    // A '/proc/stat' patch replaces the text of procStat() too; the clock stays r's.
    procStat: async () => {
      const files = p.files ?? {};
      if (!('/proc/stat' in files)) return r.procStat();
      const text = files['/proc/stat'] ?? null;
      const read = await r.procStat();
      return text === null || read === null ? null : { text, monoMs: read.monoMs };
    },
    cmd: async (file, args) => {
      calls.push({ file, args: [...args] });
      const answer = p.cmd?.(file, args);
      return answer === undefined ? r.cmd(file, args) : answer;
    },
    fdCount: (pid) => r.fdCount(pid),
    pids: () => r.pids(),
  };
}

/** Every null (or non-finite number) leaf, as a dotted path: the sample's "missing" set. */
export function nullPaths(value: unknown, path = ''): string[] {
  if (value === null) return [path];
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [`${path}=${value}`];
  if (Array.isArray(value)) return value.flatMap((v: unknown, i) => nullPaths(v, `${path}[${i}]`));
  if (typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) =>
      nullPaths(v, path === '' ? k : `${path}.${k}`),
    );
  return [];
}

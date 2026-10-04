/**
 * P8.4 — the SUT sampler, in-process in the controller on the SUT (design §9).
 * Shared host counters plus the SUT section: TURN relay-range sockets, TURN/TLS
 * hop connections, ufw new-flow counters for 3478/7882, container restarts and
 * health, LiveKit HTTP health, nginx per-worker FDs and error-log counts, and
 * LiveKit / harness process counters by PID. Everything is READ-ONLY and every
 * process is found by exact identity (container name, pid file, parent PID) —
 * never by a name pattern.
 */
import { request } from 'node:http';

import { countLines, parseFwNewFlows, parseNginxErrors, parsePidStat } from '../metrics/procfs';
import { type Readers, procsOf, sampleBase } from './host-base';
import { type HostSample, SAMPLE_SCHEMA, type SutSection } from './sample';

export interface SutSamplerOptions {
  readonly runId: string;
  readonly rung: string;
  readonly iface: string;
  readonly livekitContainer: string;
  readonly containers: readonly string[];
  readonly livekitHealthUrl: string;
  readonly nginxPidFile: string;
  readonly nginxConf: string;
  readonly nginxErrorLog: string;
  /** Harness processes on the SUT (controller), reported as harness overhead. */
  readonly harnessPids: ReadonlyArray<{ readonly pid: number; readonly role: string }>;
}

export const SUT_DEFAULTS = {
  iface: 'eth0',
  livekitContainer: 'institution-livekit-1',
  containers: [
    'institution-api-1',
    'institution-livekit-1',
    'institution-redis-1',
    'institution-db-1',
  ],
  livekitHealthUrl: 'http://127.0.0.1:7880/',
  nginxPidFile: '/run/nginx.pid',
  nginxConf: '/etc/nginx/nginx.conf',
  nginxErrorLog: '/var/log/nginx/error.log',
} as const;

/** `docker inspect -f '{{.Name}} {{.State.Pid}} {{.RestartCount}} <health>'` lines. Pure. */
export function parseInspect(
  text: string,
): Array<{ name: string; pid: number; restarts: number; health: string }> {
  return text
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length === 4)
    .map(([name, pid, restarts, health]) => ({
      name: (name ?? '').replace(/^\//, ''),
      pid: Number(pid),
      restarts: Number(restarts),
      health: health ?? 'none',
    }));
}

/** `worker_connections N;` from nginx.conf, or null. Pure. */
export function parseWorkerConnections(conf: string): number | null {
  for (const line of conf.split('\n')) {
    const code = line.replace(/#.*/, ''); // a commented directive does not count
    const m = /(?:^|[\s{;])worker_connections\s+(\d+)\s*;/.exec(code);
    if (m) return Number(m[1]);
  }
  return null;
}

function httpStatus(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = request(url, { method: 'GET', timeout: 2_000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

export class SutSampler {
  private seq = 0;
  private errorLogOffset = 0;
  private rotatedSeen = false;

  constructor(
    private readonly r: Readers,
    private readonly o: SutSamplerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** Marks the rung baseline: error-log lines before this point are not counted. */
  async baseline(): Promise<void> {
    this.errorLogOffset = (await this.r.file(this.o.nginxErrorLog))?.length ?? 0;
    this.rotatedSeen = false;
  }

  async sample(): Promise<HostSample> {
    const [base, inspect] = await Promise.all([
      sampleBase(this.r, this.o.iface),
      this.r.cmd('docker', [
        'inspect',
        '-f',
        '{{.Name}} {{.State.Pid}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
        ...this.o.containers,
      ]),
    ]);
    const containers = inspect === null ? null : parseInspect(inspect);
    const lk = containers?.find((c) => c.name === this.o.livekitContainer);
    const procs = await procsOf(this.r, [
      ...(lk && lk.pid > 0 ? [{ pid: lk.pid, role: 'livekit' }] : []),
      ...this.o.harnessPids,
    ]);
    this.seq += 1;
    return {
      schema: SAMPLE_SCHEMA,
      runId: this.o.runId,
      rung: this.o.rung,
      host: 'sut',
      role: 'sut',
      t: this.now(),
      seq: this.seq,
      clockOffsetMs: null,
      ...base,
      procs,
      sut: await this.sutSection(containers),
      gen: null,
    };
  }

  private async sutSection(
    containers: ReturnType<typeof parseInspect> | null,
  ): Promise<SutSection> {
    const [relay, tls, fw4, fw6, health, nginx] = await Promise.all([
      this.r.cmd('ss', ['-H', '-uan', 'sport >= :30000 and sport <= :32767']),
      this.r.cmd('ss', [
        '-H',
        '-tn',
        'state',
        'established',
        '( sport = :8444 or dport = :8444 or sport = :5349 or dport = :5349 )',
      ]),
      this.r.cmd('iptables', ['-L', 'ufw-user-input', '-v', '-x', '-n']),
      this.r.cmd('ip6tables', ['-L', 'ufw6-user-input', '-v', '-x', '-n']),
      httpStatus(this.o.livekitHealthUrl),
      this.nginx(),
    ]);
    const flows =
      fw4 === null || fw6 === null
        ? null
        : [parseFwNewFlows(fw4, [3478, 7882]), parseFwNewFlows(fw6, [3478, 7882])];
    return {
      relaySockets: relay === null ? null : countLines(relay),
      turnTlsEstab: tls === null ? null : countLines(tls),
      fwNewFlows: flows
        ? {
            udp3478: (flows[0]?.[3478] ?? 0) + (flows[1]?.[3478] ?? 0),
            udp7882: (flows[0]?.[7882] ?? 0) + (flows[1]?.[7882] ?? 0),
          }
        : null,
      containers:
        containers?.map(({ name, restarts, health: h }) => ({ name, restarts, health: h })) ?? null,
      livekitHttp: health,
      nginx,
    };
  }

  /** nginx workers are the children of the master in the pid file (exact parent PID). */
  private async nginx(): Promise<SutSection['nginx']> {
    const [pidText, conf, log] = await Promise.all([
      this.r.file(this.o.nginxPidFile),
      this.r.file(this.o.nginxConf),
      this.r.file(this.o.nginxErrorLog),
    ]);
    const master = Number(pidText?.trim());
    const workerConnections = conf === null ? null : parseWorkerConnections(conf);
    if (!Number.isInteger(master) || master <= 0 || workerConnections === null || log === null)
      return null;
    const children = (await this.r.file(`/proc/${master}/task/${master}/children`)) ?? '';
    const pids = children.trim().split(/\s+/).filter(Boolean).map(Number);
    const workerFds: number[] = [];
    for (const pid of pids) {
      const stat = await this.r.file(`/proc/${pid}/stat`);
      if (stat === null || parsePidStat(stat)?.ppid !== master) continue;
      const fds = await this.r.fdCount(pid);
      if (fds !== null) workerFds.push(fds);
    }
    const errors = parseNginxErrors(await this.errorLinesSinceBaseline(log));
    return {
      workerConnections,
      workerFds,
      errorWorkerConnections: errors.workerConnections,
      errorUpstream: errors.upstream,
    };
  }

  /**
   * Error-log text written since the baseline. After a logrotate the live file is
   * shorter than the baseline offset: the rest of the pre-rotation lines are in
   * `<log>.1` and every line of the new file is new.
   */
  private async errorLinesSinceBaseline(live: string): Promise<string> {
    if (live.length >= this.errorLogOffset && !this.rotatedSeen)
      return live.slice(this.errorLogOffset);
    this.rotatedSeen = true;
    const rotated = (await this.r.file(`${this.o.nginxErrorLog}.1`)) ?? '';
    return `${rotated.slice(this.errorLogOffset)}\n${live}`;
  }
}

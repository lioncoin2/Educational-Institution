/**
 * P8.4 — the GENERATOR host sampler (runs in-process in each agent). Shared host
 * counters (observe/host-base.ts) plus the generator section: live participants,
 * egress flows to SUT:3478 (TURN attribution, T6), TCP connections to SUT:443
 * (T7), link speed and clock offset. Read-only; a failed read is null.
 */
import { countLines, parsePidStat } from '../metrics/procfs';
import { type BaseCounters, type Readers, procsOf, sampleBase } from './host-base';
import { type GeneratorSection, type HostSample, SAMPLE_SCHEMA } from './sample';

export interface HostSamplerOptions {
  readonly runId: string;
  readonly rung: string;
  readonly host: string;
  readonly iface: string;
  readonly sutAddress: string;
}

/** `chronyc -c tracking` → the system-time offset in ms (field 5, seconds), or null. Pure. */
export function parseChronyOffsetMs(text: string): number | null {
  const field = text.trim().split(',')[4]?.trim() ?? '';
  const seconds = Number(field);
  return field !== '' && Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** /sys/class/net/<if>/speed → Mbit/s, or null when unknown (virtio reports -1). Pure. */
export function parseLinkSpeed(text: string): number | null {
  const v = Number(text.trim());
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Classifies a process group by ownership. Pure (GeneratorSection.processGroup). */
export function classifyGroup(
  members: ReadonlyArray<{ readonly pid: number; readonly ppid: number }>,
  agentPid: number,
  workerPids: ReadonlySet<number>,
): NonNullable<GeneratorSection['processGroup']> {
  let workers = 0;
  let helpers = 0;
  let unexplained = 0;
  for (const m of members) {
    if (m.pid === agentPid) continue;
    if (workerPids.has(m.pid)) workers += 1;
    else if (workerPids.has(m.ppid)) helpers += 1;
    else unexplained += 1;
  }
  return { members: members.length, workers, helpers, unexplained };
}

export class HostSampler {
  private seq = 0;

  constructor(
    private readonly r: Readers,
    private readonly o: HostSamplerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  async sample(
    procs: ReadonlyArray<{ readonly pid: number; readonly role: string }>,
    participants: number,
  ): Promise<HostSample> {
    const sut = this.o.sutAddress;
    const [base, counters, flows3478, tcp443, speed, chrony]: [
      BaseCounters,
      Awaited<ReturnType<typeof procsOf>>,
      string | null,
      string | null,
      string | null,
      string | null,
    ] = await Promise.all([
      sampleBase(this.r, this.o.iface),
      procsOf(this.r, procs),
      this.r.cmd('ss', ['-H', '-uan', 'dst', `${sut}:3478`]),
      this.r.cmd('ss', ['-H', '-tn', 'state', 'established', 'dst', `${sut}:443`]),
      this.r.file(`/sys/class/net/${this.o.iface}/speed`),
      this.r.cmd('chronyc', ['-c', 'tracking']),
    ]);
    const processGroup = await this.group(procs);
    this.seq += 1;
    return {
      schema: SAMPLE_SCHEMA,
      runId: this.o.runId,
      rung: this.o.rung,
      host: this.o.host,
      role: 'generator',
      t: this.now(),
      seq: this.seq,
      clockOffsetMs: chrony === null ? null : parseChronyOffsetMs(chrony),
      ...base,
      procs: counters,
      sut: null,
      gen: {
        participants,
        flowsToSut3478: flows3478 === null ? null : countLines(flows3478),
        tcpToSut443: tcp443 === null ? null : countLines(tcp443),
        linkMbps: speed === null ? null : parseLinkSpeed(speed),
        processGroup,
      },
    };
  }

  /** Members of the agent's process group (exact pgid match), classified by ownership. */
  private async group(
    procs: ReadonlyArray<{ readonly pid: number; readonly role: string }>,
  ): Promise<GeneratorSection['processGroup']> {
    const agent = procs.find((p) => p.role === 'agent');
    const agentStat = agent ? await this.r.file(`/proc/${agent.pid}/stat`) : null;
    const pgid = agentStat === null ? null : parsePidStat(agentStat)?.pgrp;
    const pids = await this.r.pids();
    if (!agent || pgid === undefined || pgid === null || pids === null) return null;
    // One small read per PID, issued together: a sequential scan is too slow on a busy host.
    const stats = await Promise.all(pids.map((pid) => this.r.file(`/proc/${pid}/stat`)));
    const members: Array<{ pid: number; ppid: number }> = [];
    stats.forEach((stat, k) => {
      const s = stat === null ? null : parsePidStat(stat);
      const pid = pids[k];
      if (s && pid !== undefined && s.pgrp === pgid) members.push({ pid, ppid: s.ppid });
    });
    const workers = new Set(procs.filter((p) => p.role.startsWith('worker')).map((p) => p.pid));
    return classifyGroup(members, agent.pid, workers);
  }
}

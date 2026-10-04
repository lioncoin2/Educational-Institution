/**
 * P8 load harness — pure parsers for the read-only host/Docker counters the
 * collector samples. Each takes raw text (the contents of a /proc file or the
 * stdout of a read-only command) and returns a typed struct. No I/O here, so
 * every parser is unit-testable against a captured fixture — which is the point:
 * parsing is where a collector silently goes wrong.
 */

export interface NetDev {
  readonly rxBytes: number;
  readonly rxPackets: number;
  readonly txBytes: number;
  readonly txPackets: number;
}

/** Parse one interface's counters from /proc/net/dev. Returns null if absent. */
export function parseNetDev(text: string, iface: string): NetDev | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${iface}:`)) continue;
    const nums = trimmed
      .slice(trimmed.indexOf(':') + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    // Columns: rxBytes rxPkts rxErrs rxDrop ... (0..), txBytes(8) txPkts(9)
    if (nums.length < 16) return null;
    return {
      rxBytes: nums[0] ?? 0,
      rxPackets: nums[1] ?? 0,
      txBytes: nums[8] ?? 0,
      txPackets: nums[9] ?? 0,
    };
  }
  return null;
}

export interface UdpSnmp {
  readonly inDatagrams: number;
  readonly inErrors: number;
  readonly rcvbufErrors: number;
  readonly sndbufErrors: number;
  readonly outDatagrams: number;
}

/** Parse the `Udp:` value row of /proc/net/snmp. */
export function parseUdpSnmp(text: string): UdpSnmp | null {
  const lines = text.split('\n').filter((l) => l.startsWith('Udp:'));
  if (lines.length < 2) return null;
  const header = (lines[0] ?? '').trim().split(/\s+/);
  const values = (lines[1] ?? '').trim().split(/\s+/);
  const at = (name: string): number => {
    const idx = header.indexOf(name);
    return idx >= 0 ? Number(values[idx] ?? 0) : 0;
  };
  return {
    inDatagrams: at('InDatagrams'),
    inErrors: at('InErrors'),
    rcvbufErrors: at('RcvbufErrors'),
    sndbufErrors: at('SndbufErrors'),
    outDatagrams: at('OutDatagrams'),
  };
}

/** Total softirq-backlog drops across all CPUs from /proc/net/softnet_stat (col 2, hex). */
export function parseSoftnetDropped(text: string): number {
  let dropped = 0;
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const value = parseInt(cols[1] ?? '', 16);
    if (Number.isFinite(value)) dropped += value;
  }
  return dropped;
}

export interface LoadAvg {
  readonly one: number;
  readonly five: number;
  readonly fifteen: number;
}

export function parseLoadAvg(text: string): LoadAvg | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return null;
  return { one: Number(parts[0]), five: Number(parts[1]), fifteen: Number(parts[2]) };
}

export interface MemInfo {
  readonly totalKb: number;
  readonly availableKb: number;
}

/** Parse MemTotal/MemAvailable from /proc/meminfo (values in kB). */
export function parseMemInfo(text: string): MemInfo | null {
  const field = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text);
    return match ? Number(match[1]) : null;
  };
  const totalKb = field('MemTotal');
  const availableKb = field('MemAvailable');
  if (totalKb === null || availableKb === null) return null;
  return { totalKb, availableKb };
}

/** Parse the integer in /proc/sys/net/netfilter/nf_conntrack_count. */
export function parseConntrackCount(text: string): number | null {
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
}

export interface ContainerStat {
  readonly name: string;
  readonly cpuPercent: number;
  readonly memMiB: number;
}

/**
 * Parse `docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'`.
 * MemUsage like "70.48MiB / 94.29GiB" → the used side in MiB.
 */
export function parseDockerStats(text: string): ContainerStat[] {
  const out: ContainerStat[] = [];
  for (const line of text.split('\n')) {
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const name = (parts[0] ?? '').trim();
    if (name === '') continue;
    const cpuPercent = Number((parts[1] ?? '').replace('%', '').trim());
    const used = (parts[2] ?? '').split('/')[0]?.trim() ?? '';
    out.push({
      name,
      cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : 0,
      memMiB: toMiB(used),
    });
  }
  return out;
}

function toMiB(value: string): number {
  const match = /([\d.]+)\s*([KMGT]i?B)?/i.exec(value);
  if (!match) return 0;
  const n = Number(match[1]);
  const unit = (match[2] ?? 'B').toUpperCase();
  const scale: Record<string, number> = {
    B: 1 / (1024 * 1024),
    KIB: 1 / 1024,
    MIB: 1,
    GIB: 1024,
    TIB: 1024 * 1024,
  };
  return n * (scale[unit] ?? 1);
}

/** Parse `ss -s` summary → total + established TCP. */
export function parseSsSummary(text: string): { total: number; estab: number } | null {
  const totalMatch = /Total:\s+(\d+)/.exec(text);
  const estabMatch = /TCP:\s+\d+\s+\(estab\s+(\d+)/.exec(text);
  if (!totalMatch) return null;
  return { total: Number(totalMatch[1]), estab: estabMatch ? Number(estabMatch[1]) : 0 };
}

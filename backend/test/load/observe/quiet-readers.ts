/**
 * TEST-ONLY — a quiet, complete host for the local (fake-driver) fleet: the
 * `--local` agent and the fleet integration tests. It decorates real `Readers`
 * so PER-PROCESS reads (`/proc/<pid>/stat|status`, fds, the PID list) stay REAL
 * — process accounting is exercised for real — while host counters are
 * synthetic, idle and complete, in the exact text formats the procfs parsers
 * read. The CPU clock of `procStat()` runs QUIET_STRETCH × real time and every
 * core gains exactly the matching idle, so each core's exact busy (wall − idle −
 * iowait, observe/cpu-meter.ts) stays REAL — the errata-E4 rule is checked
 * against real numbers — while busy % shrinks QUIET_STRETCH-fold: a busy CI
 * machine never makes the quiet host look loaded. Synthetic SUT-only sources (ss
 * sockets, docker inspect, nginx, ufw counters) are produced for role 'sut'.
 * Never used by a real run: the fleet runner refuses real load locally.
 */
import { type ProcStatRead, type Readers } from './host-base';
import { CLK_TCK } from './sample';

export interface QuietOptions {
  readonly role: 'sut' | 'generator';
  readonly iface?: string;
  /** Exact-path overrides (e.g. a test injecting a drop or a restart). */
  readonly files?: Readonly<Record<string, string>>;
}

const NGINX_MASTER = 999_990;
/** The quiet CPU clock runs this many times faster than real time (busy % ÷ 1,000). */
const QUIET_STRETCH = 1_000;
const NGINX_WORKERS = [999_991, 999_992];

export function quietReaders(real: Readers, o: QuietOptions): Readers {
  const iface = o.iface ?? 'eth0';
  let tick = 0;
  const netDev = (): string => {
    tick += 1;
    return (
      'Inter-|   Receive                                                |  Transmit\n' +
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n' +
      `  ${iface}: ${1_000 * tick} ${10 * tick} 0 0 0 0 0 0 ${1_000 * tick} ${10 * tick} 0 0 0 0 0 0\n`
    );
  };
  let origin: number | null = null;
  /** Real /proc/stat on a stretched clock: each core gains (QUIET_STRETCH − 1) × elapsed of idle. */
  const quietStat = async (): Promise<ProcStatRead | null> => {
    const read = await real.procStat();
    if (read === null) return null;
    origin ??= read.monoMs;
    const elapsedMs = read.monoMs - origin;
    const extraIdle = Math.round(((QUIET_STRETCH - 1) * elapsedMs * CLK_TCK) / 1000);
    const text = o.files?.['/proc/stat'] ?? read.text;
    return {
      text: text
        .split('\n')
        .map((line) => {
          if (!/^cpu\d+\s/.test(line)) return line;
          const f = line.trim().split(/\s+/);
          f[4] = String(Number(f[4]) + extraIdle);
          return f.join(' ');
        })
        .join('\n'),
      monoMs: origin + QUIET_STRETCH * elapsedMs,
    };
  };
  const synthetic: Record<string, () => string> = {
    '/proc/loadavg': () => '0.10 0.10 0.10 1/200 4242\n',
    '/proc/meminfo': () =>
      'MemTotal:       67108864 kB\nMemFree:        62914560 kB\nMemAvailable:   62914560 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n',
    '/proc/vmstat': () => 'nr_free_pages 3500000\noom_kill 0\n',
    '/proc/net/dev': netDev,
    '/proc/net/snmp': () =>
      'Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti MemErrors\nUdp: 100 0 0 100 0 0 0 0 0\n',
    '/proc/net/snmp6': () =>
      'Udp6InDatagrams                 \t100\nUdp6InErrors                    \t0\nUdp6OutDatagrams                \t100\nUdp6RcvbufErrors                \t0\nUdp6SndbufErrors                \t0\n',
    '/proc/net/softnet_stat': () =>
      '00000100 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000\n',
    '/proc/sys/net/netfilter/nf_conntrack_count': () => '40\n',
    '/proc/sys/net/netfilter/nf_conntrack_max': () => '262144\n',
    [`/sys/class/net/${iface}/speed`]: () => '1000\n',
    '/run/nginx.pid': () => `${NGINX_MASTER}\n`,
    '/etc/nginx/nginx.conf': () => 'events {\n\tworker_connections 768;\n}\n',
    '/var/log/nginx/error.log': () => '',
    [`/proc/${NGINX_MASTER}/task/${NGINX_MASTER}/children`]: () => `${NGINX_WORKERS.join(' ')} `,
    ...Object.fromEntries(
      NGINX_WORKERS.map((pid) => [
        `/proc/${pid}/stat`,
        () =>
          `${pid} (nginx) S ${NGINX_MASTER} ${NGINX_MASTER} ${NGINX_MASTER} 0 -1 4194624 0 0 0 0 1 1 0 0 20 0 1 0 100 1000000 500 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n`,
      ]),
    ),
  };
  const sutSockets = [
    '213.136.65.135:7882',
    '172.30.0.1:7882',
    '172.17.0.1:7882',
    '[2a02:c207:2363:1989::1]:7882',
    '*:3478',
  ]
    .map(
      (local) =>
        `UNCONN 0      0      ${local} 0.0.0.0:*\n\t skmem:(r0,rb33554432,t0,tb33554432,f0,w0,o0,bl0,d0)\n`,
    )
    .join('');
  const fw = (chain: string): string =>
    `Chain ${chain} (1 references)\n    pkts      bytes target     prot opt in     out     source               destination\n` +
    '      10      900 ACCEPT     17   --  *      *       0.0.0.0/0            0.0.0.0/0            udp dpt:7882\n' +
    '      20     1800 ACCEPT     17   --  *      *       0.0.0.0/0            0.0.0.0/0            udp dpt:3478\n';
  const command = (file: string, args: readonly string[]): string | null => {
    if (file === 'tc')
      return `qdisc fq_codel 0: root refcnt 2\n Sent ${1_000 * tick} bytes ${10 * tick} pkt (dropped 0, overlimits 0 requeues 0)\n backlog 0b 0p requeues 0\n`;
    if (file === 'chronyc')
      return 'A29FC87B,162.159.200.123,3,1791125852.000,0.000000500,0.000001,0.000002,-1.0,0.0,0.01,0.001,0.0005,64.0,Normal\n';
    if (file === 'ss') return o.role === 'sut' && args.includes('-uanm') ? sutSockets : '';
    if (file === 'iptables') return fw('ufw-user-input');
    if (file === 'ip6tables') return fw('ufw6-user-input');
    if (file === 'docker')
      return [
        'institution-api-1',
        'institution-livekit-1',
        'institution-redis-1',
        'institution-db-1',
      ]
        .map((name, i) => `/${name} ${i === 1 ? process.pid : 0} 0 healthy`)
        .join('\n');
    return null;
  };
  return {
    file: async (path) => {
      const override = o.files?.[path];
      if (override !== undefined) return override;
      const make = synthetic[path];
      return make ? make() : real.file(path);
    },
    procStat: quietStat,
    cmd: async (file, args) => command(file, args),
    fdCount: async (pid) => (NGINX_WORKERS.includes(pid) ? 50 : real.fdCount(pid)),
    pids: () => real.pids(),
  };
}

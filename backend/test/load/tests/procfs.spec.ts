import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  countLines,
  parseFwNewFlows,
  parseMemSwap,
  parseNetDevFull,
  parseNginxErrors,
  parsePidStat,
  parsePidStatus,
  parseProcStatCores,
  parseSoftnetFull,
  parseSsUdpSockets,
  parseTcQdisc,
  parseUdpSnmp4,
  parseUdpSnmp6,
  parseVmstatOomKill,
} from '../metrics/procfs';

/**
 * Fixtures: plain names are verbatim read-only captures from the SUT host (18 vCPU,
 * eth0, ufw on nft-backed iptables); `synthetic-*` are hand-written edge cases.
 */
const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', 'procfs', name), 'utf8');

describe('procfs — CPU, memory, OOM', () => {
  it('reads every per-core line of /proc/stat and skips the aggregate', () => {
    const cores = parseProcStatCores(fixture('proc-stat.txt'));
    expect(cores).toHaveLength(18);
    expect(cores?.[0]).toEqual({
      id: 0,
      user: 129459,
      nice: 220,
      sys: 57896,
      idle: 8681400,
      iowait: 5999,
      irq: 0,
      soft: 20922,
      steal: 0,
    });
    expect(cores?.[17]).toMatchObject({ id: 17, user: 62272, sys: 18549, idle: 8882000 });
  });

  it('fails closed on /proc/stat without (or with malformed) per-core lines', () => {
    expect(parseProcStatCores('')).toBeNull();
    expect(parseProcStatCores('cpu  1 2 3 4 5 6 7 8 0 0\nintr 1\n')).toBeNull();
    expect(parseProcStatCores('cpu0 1 2 3 4 5 6 7 8 0 0\ncpu1 1 2 3\n')).toBeNull();
  });

  it('reads MemTotal, MemAvailable and swap in use', () => {
    expect(parseMemSwap(fixture('meminfo.txt'))).toEqual({
      totalKb: 98873676,
      availableKb: 96546024,
      swapUsedKb: 0,
    });
    const swapping =
      'MemTotal:  8000 kB\nMemAvailable:  6000 kB\nSwapCached:  64 kB\n' +
      'SwapTotal:  2048 kB\nSwapFree:  1536 kB\n';
    expect(parseMemSwap(swapping)).toEqual({ totalKb: 8000, availableKb: 6000, swapUsedKb: 512 });
    expect(parseMemSwap('MemTotal:  8000 kB\nMemAvailable:  6000 kB\n')).toBeNull();
    expect(parseMemSwap('')).toBeNull();
  });

  it('reads oom_kill from /proc/vmstat', () => {
    expect(parseVmstatOomKill(fixture('vmstat.txt'))).toBe(0);
    expect(parseVmstatOomKill('oom_kill_disable 1\noom_kill 3\n')).toBe(3);
    expect(parseVmstatOomKill('nr_free_pages 1\n')).toBeNull();
  });
});

describe('procfs — UDP, NIC, softnet', () => {
  it('reads the IPv6 UDP counters by exact key (not UdpLite6)', () => {
    expect(parseUdpSnmp6(fixture('net-snmp6.txt'))).toEqual({
      inDatagrams: 393855,
      outDatagrams: 395774,
      inErrors: 0,
      rcvbufErrors: 0,
      sndbufErrors: 0,
    });
    const errors =
      'UdpLite6InErrors 99\nUdp6InDatagrams 10\nUdp6OutDatagrams 20\nUdp6InErrors 7\n' +
      'Udp6RcvbufErrors 5\nUdp6SndbufErrors 1\n';
    expect(parseUdpSnmp6(errors)).toEqual({
      inDatagrams: 10,
      outDatagrams: 20,
      inErrors: 7,
      rcvbufErrors: 5,
      sndbufErrors: 1,
    });
    expect(parseUdpSnmp6('Udp6InDatagrams 10\n')).toBeNull();
    expect(parseUdpSnmp6('')).toBeNull();
  });

  it('reads the IPv4 UDP counters in exactly the sample shape', () => {
    expect(parseUdpSnmp4(fixture('net-snmp.txt'))).toStrictEqual({
      inDatagrams: 442239,
      outDatagrams: 342278,
      inErrors: 179,
      rcvbufErrors: 179,
      sndbufErrors: 0,
    });
    expect(parseUdpSnmp4('')).toBeNull();
  });

  it('reads one interface of /proc/net/dev, including drops and errors', () => {
    const text = fixture('net-dev.txt');
    expect(parseNetDevFull(text, 'eth0')).toEqual({
      iface: 'eth0',
      rxBytes: 3035183994,
      txBytes: 950832824,
      rxPackets: 1610790,
      txPackets: 934163,
      rxDrop: 0,
      txDrop: 0,
      rxErr: 0,
      txErr: 0,
    });
    expect(parseNetDevFull(text, 'docker0')).toMatchObject({ rxBytes: 953157, txBytes: 70867489 });
    expect(parseNetDevFull(text, 'eth')).toBeNull();
    expect(parseNetDevFull(text, 'eth1')).toBeNull();
  });

  it('maps every /proc/net/dev column to its field', () => {
    const text = '  eth1: 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16\n  eth2: 1 2 3\n';
    expect(parseNetDevFull(text, 'eth1')).toEqual({
      iface: 'eth1',
      rxBytes: 1,
      txBytes: 9,
      rxPackets: 2,
      txPackets: 10,
      rxDrop: 4,
      txDrop: 12,
      rxErr: 3,
      txErr: 11,
    });
    expect(parseNetDevFull(text, 'eth2')).toBeNull();
  });

  it('sums softnet dropped and time_squeeze (hex) over every CPU', () => {
    expect(parseSoftnetFull(fixture('net-softnet_stat.txt'))).toEqual({
      dropped: 0,
      timeSqueeze: 59429,
    });
    const text = '000151f0 0000000a 000003ca 0 0\n0001514d 00000001 00000010 0 0\n';
    expect(parseSoftnetFull(text)).toEqual({ dropped: 11, timeSqueeze: 0x3da });
    expect(parseSoftnetFull('')).toEqual({ dropped: 0, timeSqueeze: 0 });
  });
});

describe('procfs — /proc/<pid>', () => {
  it('reads a real /proc/<pid>/stat', () => {
    expect(parsePidStat(fixture('pid-stat-self.txt'))).toEqual({
      pid: 746897,
      state: 'R',
      ppid: 746888,
      pgrp: 746897,
      utime: 1,
      stime: 3,
      starttime: 9049449,
    });
  });

  it('splits after the LAST ")" when comm contains ") ("', () => {
    expect(parsePidStat(fixture('synthetic-pid-stat-comm-parens.txt'))).toEqual({
      pid: 4242,
      state: 'S',
      ppid: 1,
      pgrp: 4240,
      utime: 1234,
      stime: 567,
      starttime: 98765,
    });
  });

  it('fails closed on empty or truncated stat', () => {
    expect(parsePidStat('')).toBeNull();
    expect(parsePidStat('4242 (node) S 1 4240 4240 0 -1 0 0 0 0 0 7 8\n')).toBeNull();
  });

  it('reads VmRSS and Threads; a kernel thread has no VmRSS', () => {
    expect(parsePidStatus(fixture('pid-status-self.txt'))).toEqual({ rssKb: 1852, threads: 1 });
    expect(parsePidStatus(fixture('pid-status-kthreadd.txt'))).toEqual({ rssKb: 0, threads: 1 });
    expect(parsePidStatus('Name:\tnode\nVmRSS:\t  100 kB\n')).toBeNull();
    expect(parsePidStatus('')).toBeNull();
  });
});

describe('procfs — ss per-socket drops and line counts', () => {
  it('reads every UDP socket of the SUT with its skmem drops', () => {
    const sockets = parseSsUdpSockets(fixture('ss-uanm.txt'));
    expect(sockets).toEqual([
      { local: '127.0.0.54:53', port: 53, drops: 0 },
      { local: '127.0.0.53%lo:53', port: 53, drops: 0 },
      { local: '172.30.0.1:7882', port: 7882, drops: 0 },
      { local: '172.17.0.1:7882', port: 7882, drops: 0 },
      { local: '213.136.65.135:7882', port: 7882, drops: 0 },
      { local: '*:3478', port: 3478, drops: 179 },
      { local: '[2a02:c207:2363:1989::1]:7882', port: 7882, drops: 0 },
    ]);
    // The expected-socket shape the sampler asserts (design §9): 4 × 7882, 1 × 3478.
    expect(sockets.filter((s) => s.port === 7882)).toHaveLength(4);
    expect(sockets.filter((s) => s.port === 3478)).toHaveLength(1);
  });

  it('handles v6/zone addresses, missing skmem, and skmem without d<N>', () => {
    expect(parseSsUdpSockets(fixture('synthetic-ss-uanm-edge.txt'))).toEqual([
      // No skmem block at all: 0, and it does not borrow the next socket's d12.
      { local: '0.0.0.0:68', port: 68, drops: 0 },
      { local: '[::]:5353', port: 5353, drops: 12 },
      { local: '[fe80::1%eth0]:546', port: 546, drops: 0 },
      // 127.0.0.53%lo:53 has skmem but no d<N>: omitted, never zeroed.
      { local: '10.0.0.5:40000', port: 40000, drops: 7 },
    ]);
  });

  it('reads skmem on the socket line itself (ss -O)', () => {
    const line = 'UNCONN 0 0 *:3478 *:* skmem:(r0,rb212992,t0,tb212992,f0,w0,o0,bl0,d3)\n';
    expect(parseSsUdpSockets(line)).toEqual([{ local: '*:3478', port: 3478, drops: 3 }]);
  });

  it('returns no sockets for empty input or orphan continuation lines', () => {
    expect(parseSsUdpSockets('')).toEqual([]);
    expect(parseSsUdpSockets('\t skmem:(r0,bl0,d5)\n')).toEqual([]);
  });

  it('counts non-empty lines', () => {
    expect(countLines(fixture('ss-uanm.txt'))).toBe(14); // 7 sockets × 2 lines with -m
    expect(countLines('a\n\n   \nb\n')).toBe(2);
    expect(countLines('')).toBe(0);
  });
});

describe('procfs — tc qdisc', () => {
  it('reads the root fq_codel block', () => {
    expect(parseTcQdisc(fixture('tc-qdisc-eth0.txt'))).toEqual({ dropped: 1, overlimits: 0 });
  });

  it('reads only the root block of an mq qdisc (children are already aggregated)', () => {
    expect(parseTcQdisc(fixture('synthetic-tc-qdisc-mq.txt'))).toEqual({
      dropped: 9,
      overlimits: 4,
    });
  });

  it('fails closed when the first block is not root or has no Sent line', () => {
    expect(parseTcQdisc('')).toBeNull();
    expect(
      parseTcQdisc(
        'qdisc fq_codel 0: parent :1 limit 10240p\n' +
          ' Sent 1 bytes 1 pkt (dropped 2, overlimits 3 requeues 0)\n',
      ),
    ).toBeNull();
    expect(
      parseTcQdisc(
        'qdisc mq 0: root\n backlog 0b 0p requeues 0\n' +
          'qdisc fq_codel 0: parent :1\n Sent 1 bytes 1 pkt (dropped 2, overlimits 3 requeues 0)\n',
      ),
    ).toBeNull();
  });
});

describe('procfs — ufw new-flow counters', () => {
  it('reads udp dpt rows from nft-backed iptables (prot 17)', () => {
    expect(parseFwNewFlows(fixture('iptables-ufw-user-input.txt'), [3478, 7882])).toEqual({
      3478: 13855,
      7882: 70,
    });
    expect(parseFwNewFlows(fixture('ip6tables-ufw6-user-input.txt'), [3478, 7882])).toEqual({
      3478: 0,
      7882: 0,
    });
  });

  it('sums udp rows only, matches the exact port, and reports absent ports as 0', () => {
    expect(parseFwNewFlows(fixture('synthetic-iptables-legacy.txt'), [3478, 7882])).toEqual({
      3478: 45,
      7882: 0,
    });
    expect(parseFwNewFlows('', [3478])).toEqual({ 3478: 0 });
  });
});

describe('procfs — nginx error log', () => {
  it('counts worker_connections and upstream failures independently', () => {
    expect(parseNginxErrors(fixture('synthetic-nginx-error.txt'))).toEqual({
      workerConnections: 2,
      upstream: 4,
    });
    expect(parseNginxErrors('')).toEqual({ workerConnections: 0, upstream: 0 });
  });
});

import {
  parseConntrackCount,
  parseDockerStats,
  parseLoadAvg,
  parseMemInfo,
  parseNetDev,
  parseSoftnetDropped,
  parseSsSummary,
  parseUdpSnmp,
} from '../metrics/parsers';
import { toCsvRow, type Sample } from '../metrics/collector';

describe('metrics parsers', () => {
  it('parses /proc/net/dev for an interface', () => {
    const text =
      'Inter-|   Receive\n face |bytes\n' +
      '    lo: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n' +
      '  eth0: 100 2 0 0 0 0 0 0 200 3 0 0 0 0 0 0\n';
    expect(parseNetDev(text, 'eth0')).toEqual({
      rxBytes: 100,
      rxPackets: 2,
      txBytes: 200,
      txPackets: 3,
    });
    expect(parseNetDev(text, 'wlan0')).toBeNull();
  });

  it('parses /proc/net/snmp Udp errors by header name', () => {
    const text =
      'Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti MemErrors\n' +
      'Udp: 229803 144 5 123894 7 0 0 616 0\n';
    expect(parseUdpSnmp(text)).toEqual({
      inDatagrams: 229803,
      inErrors: 5,
      rcvbufErrors: 7,
      sndbufErrors: 0,
      outDatagrams: 123894,
    });
  });

  it('sums softnet drops across cpus (hex col 2)', () => {
    const text = '00007112 00000003 0000018b 0 0\n0000775e 00000000 00000161 0 0\n';
    expect(parseSoftnetDropped(text)).toBe(3);
  });

  it('parses loadavg, meminfo, conntrack', () => {
    expect(parseLoadAvg('0.64 0.44 0.36 1/234 5678')).toEqual({
      one: 0.64,
      five: 0.44,
      fifteen: 0.36,
    });
    expect(parseMemInfo('MemTotal:       98566160 kB\nMemAvailable:   96000000 kB\n')).toEqual({
      totalKb: 98566160,
      availableKb: 96000000,
    });
    expect(parseConntrackCount('75\n')).toBe(75);
  });

  it('parses docker stats rows into used MiB', () => {
    const text =
      'institution-api-1|0.02%|64.01MiB / 94.29GiB\n' +
      'institution-livekit-1|7.50%|44.07MiB / 94.29GiB\n';
    const stats = parseDockerStats(text);
    expect(stats).toHaveLength(2);
    expect(stats[0]).toEqual({ name: 'institution-api-1', cpuPercent: 0.02, memMiB: 64.01 });
    expect(stats[1]?.cpuPercent).toBe(7.5);
  });

  it('parses ss -s summary', () => {
    expect(
      parseSsSummary('Total: 292\nTCP:   58 (estab 9, closed 18, orphaned 0, timewait 6)\n'),
    ).toEqual({ total: 292, estab: 9 });
  });

  it('derives per-second rates in a CSV row from two samples', () => {
    const prev: Sample = sample(0, { txBytes: 0, txPackets: 0, rxBytes: 0 });
    const cur: Sample = sample(1000, { txBytes: 125_000_00, txPackets: 1000, rxBytes: 0 });
    const row = toCsvRow(prev, cur).split(',');
    // 12.5e6 bytes/s * 8 / 1e6 = 100 Mbps
    expect(row[1]).toBe('100.00');
    expect(row[2]).toBe('1000');
  });
});

function sample(tMs: number, over: Partial<Sample>): Sample {
  return {
    tMs,
    txBytes: 0,
    txPackets: 0,
    rxBytes: 0,
    udpInErrors: 0,
    udpRcvbufErrors: 0,
    softnetDropped: 0,
    load1: 0.5,
    memAvailableMiB: 90000,
    conntrack: 75,
    estabConns: 9,
    containers: [{ name: 'institution-livekit-1', cpuPercent: 5, memMiB: 44 }],
    ...over,
  };
}

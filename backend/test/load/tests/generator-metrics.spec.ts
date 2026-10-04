import {
  GENERATOR_CSV_HEADER,
  GeneratorCounters,
  cpuPercent,
  toGeneratorCsvRow,
  type GeneratorSample,
} from '../metrics/generator';

describe('generator-side metrics', () => {
  it('counters snapshot reflects increments', () => {
    const c = new GeneratorCounters();
    c.connectOk += 3;
    c.connectFail += 1;
    c.relayOk += 2;
    const snap = c.snapshot();
    expect(snap.connect_ok).toBe(3);
    expect(snap.connect_fail).toBe(1);
    expect(snap.relay_ok).toBe(2);
    expect(snap.publish_ok).toBe(0);
  });

  it('derives CPU percent from cpuUsage deltas over wall time', () => {
    // 500ms of CPU over 1000ms wall = 50%
    expect(cpuPercent(0, 500_000, 1000)).toBeCloseTo(50, 5);
    expect(cpuPercent(0, 0, 1000)).toBe(0);
    expect(cpuPercent(0, 1000, 0)).toBe(0);
  });

  it('derives per-second NIC rates in a CSV row', () => {
    const base = {
      procCpuPercent: 10,
      procRssMiB: 100,
      counters: new GeneratorCounters().snapshot(),
    };
    const prev: GeneratorSample = { tMs: 0, genTxBytes: 0, genRxBytes: 0, ...base };
    const cur: GeneratorSample = {
      tMs: 1000,
      genTxBytes: 125_000_00,
      genRxBytes: 250_000_0,
      ...base,
    };
    const row = toGeneratorCsvRow(prev, cur, 42).split(',');
    expect(row[3]).toBe('100.00'); // tx mbps
    expect(row[4]).toBe('20.00'); // rx mbps
    expect(row[5]).toBe('42'); // active
    expect(GENERATOR_CSV_HEADER.split(',')).toContain('relay_ok');
  });
});

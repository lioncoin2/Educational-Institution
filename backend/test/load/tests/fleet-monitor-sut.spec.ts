import { readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';

import { type SutPort } from '../fleet/monitor';
import { type Readers } from '../observe/host-base';
import { quietReaders } from '../observe/quiet-readers';
import { ABORT_SCHEMA, type HostSample } from '../observe/sample';
import { SUT_DEFAULTS, SutSampler } from '../observe/sut-sampler';
import { INTERVAL, RUN, RUNG, monitorWith, sutSample } from './support/monitor-fixtures';

// ---------------------------------------------------------------------------------------------
// RunMonitor — the SUT watchdog

/** A SutPort replaying `script` (an Error rejects that sample); exhausted = rejects. */
class ScriptedSut implements SutPort {
  baselines = 0;
  samples = 0;

  constructor(private readonly script: ReadonlyArray<HostSample | Error>) {}

  async baseline(): Promise<void> {
    this.baselines += 1;
  }

  async sample(): Promise<HostSample> {
    const next = this.script[this.samples] ?? new Error('script exhausted');
    this.samples += 1;
    if (next instanceof Error) throw next;
    return next;
  }
}

/** A SutPort whose first sample is immediate and each later one resolves only on `resolve()`. */
class DeferredSut implements SutPort {
  calls = 0;
  private pending: ((s: HostSample) => void) | null = null;

  constructor(private readonly first: HostSample) {}

  async baseline(): Promise<void> {}

  sample(): Promise<HostSample> {
    this.calls += 1;
    if (this.calls === 1) return Promise.resolve(this.first);
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  resolve(s: HostSample): void {
    this.pending?.(s);
    this.pending = null;
  }
}

/** Lets pending promise callbacks run (setImmediate is left real). */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function tick(): Promise<void> {
  jest.advanceTimersByTime(INTERVAL);
  await settle();
}

describe('fleet/monitor — SUT watchdog (scripted SUT port)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('start() takes the baseline, keeps the first sample unjudged, then samples each interval', async () => {
    const sut = new ScriptedSut([sutSample(0), sutSample(1), sutSample(2)]);
    const { monitor, aborts } = monitorWith(sut);
    await monitor.start();
    try {
      expect(sut.baselines).toBe(1);
      expect(monitor.sutSamples).toHaveLength(1);
      expect(monitor.baseline()).toBe(monitor.sutSamples[0]);
      expect(monitor.notGreen).toEqual([]);
      await tick();
      await tick();
      expect(monitor.sutSamples.map((s) => s.seq)).toEqual([0, 1, 2]);
      // A quiet, complete SUT: every SUT rule judged GREEN, none missing.
      expect([...monitor.missing]).toEqual([]);
      expect(monitor.notGreen).toEqual([]);
      expect(aborts).toEqual([]);
    } finally {
      monitor.stop();
    }
  });

  it('fires onAbort for a SUT RED with source sut-watchdog', async () => {
    const sut = new ScriptedSut([sutSample(0), sutSample(1, { oomKills: 2 })]);
    const { monitor, aborts } = monitorWith(sut);
    await monitor.start();
    try {
      expect(aborts).toEqual([]);
      await tick();
      expect(aborts).toEqual([
        {
          schema: ABORT_SCHEMA,
          runId: RUN,
          rung: RUNG,
          at: INTERVAL,
          source: 'sut-watchdog',
          rule: 'S-oom',
          observed: { value: 2, unit: 'kills', samples: [2] },
          threshold: { op: '>', value: 0, sustain: 'instant' },
          classHint: 'C',
          validity: false,
          detail: 'S-oom > 0 (instant)',
        },
      ]);
      expect(monitor.fired).toMatchObject([{ ruleId: 'S-oom', scope: 'sut', host: 'sut' }]);
    } finally {
      monitor.stop();
    }
  });

  it('a sustained SUT rule fires only once sustained (S-lk-health: 2 consecutive non-200)', async () => {
    const sut = new ScriptedSut([
      sutSample(0),
      sutSample(1, {}, { livekitHttp: 503 }),
      sutSample(2, {}, { livekitHttp: null }),
    ]);
    const { monitor, aborts } = monitorWith(sut);
    await monitor.start();
    try {
      await tick();
      expect(aborts).toEqual([]);
      expect(monitor.notGreen).toEqual([
        { ruleId: 'S-lk-health', scope: 'sut', at: INTERVAL, overRed: true },
      ]);
      await tick();
      expect(aborts).toMatchObject([
        {
          source: 'sut-watchdog',
          rule: 'S-lk-health',
          at: 2 * INTERVAL,
          observed: { value: 2, unit: 'samples', samples: [1, 2] },
          threshold: { op: '>', value: 0, sustain: '2 consecutive samples' },
          classHint: 'B',
          validity: false,
        },
      ]);
    } finally {
      monitor.stop();
    }
  });

  it('skips a failed SUT sample without throwing and judges the next one', async () => {
    const sut = new ScriptedSut([sutSample(0), new Error('ss: timeout'), sutSample(2)]);
    const { monitor, aborts } = monitorWith(sut);
    await monitor.start();
    try {
      await tick();
      expect(sut.samples).toBe(2);
      expect(monitor.sutSamples).toHaveLength(1);
      await tick();
      expect(monitor.sutSamples.map((s) => s.seq)).toEqual([0, 2]);
      expect(aborts).toEqual([]);
    } finally {
      monitor.stop();
    }
  });

  it('stop() ends periodic sampling', async () => {
    const sut = new ScriptedSut([sutSample(0), sutSample(1), sutSample(2)]);
    const { monitor } = monitorWith(sut);
    await monitor.start();
    monitor.stop();
    await tick();
    await tick();
    expect(sut.samples).toBe(1);
    expect(monitor.sutSamples).toHaveLength(1);
  });

  it('regression: a slow SUT sample is never overlapped by the next tick', async () => {
    // Overlapping samples completed out of read order, so a sample could carry OLDER counters
    // than the previous one (captured intermittent failure: missing S-cpu-hot and S-tx).
    const sut = new DeferredSut(sutSample(0));
    const { monitor, aborts } = monitorWith(sut);
    await monitor.start();
    try {
      await tick(); // tick 1: sample 1 starts and stays in flight
      await tick();
      await tick();
      await tick();
      expect(sut.calls).toBe(2); // the start sample + the one in flight — no overlap
      sut.resolve(sutSample(1));
      await settle();
      expect(monitor.sutSamples.map((s) => s.seq)).toEqual([0, 1]);
      await tick(); // the next tick samples again
      expect(sut.calls).toBe(3);
      sut.resolve(sutSample(2));
      await settle();
      expect(monitor.sutSamples.map((s) => s.seq)).toEqual([0, 1, 2]);
      expect([...monitor.missing]).toEqual([]);
      expect(aborts).toEqual([]);
    } finally {
      monitor.stop();
    }
  });

  it('a sample still in flight at stop() is discarded', async () => {
    const sut = new DeferredSut(sutSample(0));
    const { monitor } = monitorWith(sut);
    await monitor.start();
    await tick();
    expect(sut.calls).toBe(2);
    monitor.stop();
    sut.resolve(sutSample(1));
    await settle();
    expect(monitor.sutSamples.map((s) => s.seq)).toEqual([0]);
  });

  it('without a SUT port start() samples nothing and there is no baseline', async () => {
    const { monitor, aborts } = monitorWith(null);
    await monitor.start();
    await tick();
    expect(monitor.sutSamples).toEqual([]);
    expect(monitor.baseline()).toBeNull();
    expect(aborts).toEqual([]);
    monitor.stop();
  });
});

// ---------------------------------------------------------------------------------------------
// RunMonitor over a realistic SUT sample: the real SutSampler on quiet readers

const PROC_STAT = readFileSync(join(__dirname, 'fixtures', 'procfs', 'proc-stat.txt'), 'utf8');

/** Only /proc/stat is "real" (a fixture); quietReaders synthesises the rest of the host. */
const fixtureReaders = (): Readers => ({
  file: async (path) =>
    path === '/proc/stat' ? PROC_STAT : path === '/proc/cmdline' ? 'root=/dev/sda1 ro\n' : null,
  procStat: async () => ({ text: PROC_STAT, monoMs: performance.now() }),
  cmd: async () => null,
  fdCount: async () => null,
  pids: async () => [],
});

async function until(done: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('fleet/monitor — SUT watchdog over SutSampler + quiet readers', () => {
  let health: Server;
  let healthUrl = '';

  beforeAll(async () => {
    health = createServer((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    await new Promise<void>((resolve) => health.listen(0, '127.0.0.1', resolve));
    healthUrl = `http://127.0.0.1:${(health.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    health.closeAllConnections();
    await new Promise((resolve) => health.close(resolve));
  });

  it('judges a quiet host GREEN with no missing metric, then an OOM kill as a sut-watchdog RED', async () => {
    const files: Record<string, string> = {};
    let clock = 0;
    const sampler = new SutSampler(
      quietReaders(fixtureReaders(), { role: 'sut', files }),
      { ...SUT_DEFAULTS, runId: RUN, rung: RUNG, livekitHealthUrl: healthUrl, harnessPids: [] },
      () => (clock += INTERVAL),
    );
    const { monitor, aborts } = monitorWith(sampler, 10);
    await monitor.start();
    try {
      await until(() => monitor.sutSamples.length >= 3);
      expect([...monitor.missing]).toEqual([]);
      expect(monitor.notGreen).toEqual([]);
      expect(aborts).toEqual([]);

      files['/proc/vmstat'] = 'nr_free_pages 3500000\noom_kill 1\n';
      await until(() => aborts.length > 0);
      expect(aborts[0]).toMatchObject({
        source: 'sut-watchdog',
        rule: 'S-oom',
        observed: { value: 1, unit: 'kills' },
        classHint: 'C',
        validity: false,
      });
    } finally {
      monitor.stop();
    }
  });
});

import { AdjustableClock } from '../../../../test/support/identity-harness';
import { captureLogs } from '../../../../test/support/live-harness';
import {
  RtcMisconfiguredError,
  RtcUnavailableError,
  type RtcNotReadyReason,
  type RtcReadinessProbe,
  type RtcReadinessReport,
} from '../domain/rtc-provider';
import { LiveMediaReadiness } from './live-media-readiness';

const READY: RtcReadinessReport = { ready: true };
const notReady = (reason: RtcNotReadyReason): RtcReadinessReport => ({ ready: false, reason });

/** A self-check that answers what it is told, when it is told — counted. */
class ScriptedProbe implements RtcReadinessProbe {
  calls = 0;
  private next: () => Promise<RtcReadinessReport> = async () => READY;

  answer(report: RtcReadinessReport): void {
    this.next = async () => report;
  }

  throws(error: unknown): void {
    this.next = async () => {
      throw error;
    };
  }

  /** The next check waits until `release` — for a check still running. */
  hold(report: RtcReadinessReport): () => void {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.next = async () => {
      await released;
      return report;
    };
    return release;
  }

  check(): Promise<RtcReadinessReport> {
    this.calls += 1;
    return this.next();
  }
}

describe('the media provider’s readiness (P7.1)', () => {
  let clock: AdjustableClock;
  let probe: ScriptedProbe;
  let readiness: LiveMediaReadiness;
  let logs: ReturnType<typeof captureLogs>;

  beforeEach(() => {
    logs = captureLogs();
    clock = new AdjustableClock(new Date('2026-09-27T09:00:00.000Z'));
    probe = new ScriptedProbe();
    readiness = new LiveMediaReadiness(probe, clock);
  });

  afterEach(() => jest.restoreAllMocks());

  /** The health-check lines logged so far: level, status and reason. */
  const healthChecks = () =>
    logs.lines
      .filter((line) => line.fields.event === 'live.provider.health_check')
      .map((line) => ({ level: line.level, ...line.fields }));

  it('has no report until the provider is first asked, then keeps it with when it was asked', async () => {
    expect(readiness.current).toBeNull();
    const asked = clock.now();
    await expect(readiness.refresh()).resolves.toEqual(READY);
    expect(readiness.current).toEqual({ report: READY, at: asked });
    expect(probe.calls).toBe(1);
  });

  it('asks the provider once for any number of refreshes while a check runs', async () => {
    const release = probe.hold(notReady('unreachable'));
    const refreshes = [readiness.refresh(), readiness.refresh(), readiness.ensureFresh(30_000)];
    release();
    expect(await Promise.all(refreshes)).toEqual([
      notReady('unreachable'),
      notReady('unreachable'),
      notReady('unreachable'),
    ]);
    expect(probe.calls).toBe(1);
    // …and asks again once that check is over.
    probe.answer(READY);
    await expect(readiness.refresh()).resolves.toEqual(READY);
    expect(probe.calls).toBe(2);
  });

  it('answers from the last report while it is younger than asked, and asks again after', async () => {
    await readiness.ensureFresh(30_000);
    expect(probe.calls).toBe(1);
    probe.answer(notReady('auto_create_enabled'));
    clock.advance(29);
    await expect(readiness.ensureFresh(30_000)).resolves.toEqual(READY);
    expect(probe.calls).toBe(1);
    clock.advance(1);
    await expect(readiness.ensureFresh(30_000)).resolves.toEqual(notReady('auto_create_enabled'));
    expect(probe.calls).toBe(2);
  });

  it('logs live.provider.health_check once per transition — the status and the reason only', async () => {
    const sequence: RtcReadinessReport[] = [
      READY,
      READY,
      notReady('unreachable'),
      notReady('unreachable'),
      notReady('auto_create_enabled'),
      notReady('unauthorized'),
      READY,
      notReady('provider_disabled'),
    ];
    for (const report of sequence) {
      probe.answer(report);
      await readiness.refresh();
    }
    expect(healthChecks()).toEqual([
      { level: 'log', event: 'live.provider.health_check', status: 'ready' },
      {
        level: 'warn',
        event: 'live.provider.health_check',
        status: 'not_ready',
        reason: 'unreachable',
      },
      {
        level: 'error',
        event: 'live.provider.health_check',
        status: 'not_ready',
        reason: 'auto_create_enabled',
      },
      {
        level: 'error',
        event: 'live.provider.health_check',
        status: 'not_ready',
        reason: 'unauthorized',
      },
      { level: 'log', event: 'live.provider.health_check', status: 'ready' },
      {
        level: 'warn',
        event: 'live.provider.health_check',
        status: 'not_ready',
        reason: 'provider_disabled',
      },
    ]);
    expect(logs.lines).toHaveLength(6);
  });

  it.each<[RtcNotReadyReason, 'warn' | 'error']>([
    ['provider_disabled', 'warn'],
    ['unreachable', 'warn'],
    ['insecure_url', 'error'],
    ['tls_failure', 'error'],
    ['unauthorized', 'error'],
    ['auto_create_enabled', 'error'],
    ['incompatible_response', 'error'],
  ])('logs not ready for %s at %s level', async (reason, level) => {
    probe.answer(notReady(reason));
    await readiness.refresh();
    expect(healthChecks()).toEqual([
      { level, event: 'live.provider.health_check', status: 'not_ready', reason },
    ]);
  });

  it('counts a check that throws as not ready — never a rejection', async () => {
    probe.throws(new RtcUnavailableError('check'));
    await expect(readiness.refresh()).resolves.toEqual(notReady('unreachable'));
    // A configuration the provider refused keeps its own reason (P7.2, Q-B).
    probe.throws(new RtcMisconfiguredError('check', 'tls_failure'));
    await expect(readiness.refresh()).resolves.toEqual(notReady('tls_failure'));
    probe.throws(new Error('a defect'));
    await expect(readiness.refresh()).resolves.toEqual(notReady('incompatible_response'));
    probe.throws('not even an error');
    await expect(readiness.ensureFresh(0)).resolves.toEqual(notReady('incompatible_response'));
  });

  it('asks at boot without holding it, and waits for a running check when the module stops', async () => {
    const release = probe.hold(READY);
    readiness.onApplicationBootstrap();
    expect(probe.calls).toBe(1);
    let stopped = false;
    const stopping = readiness.onModuleDestroy().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(readiness.current?.report).toEqual(READY);
  });
});

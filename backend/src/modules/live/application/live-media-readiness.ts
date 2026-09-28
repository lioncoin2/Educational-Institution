import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared';
import {
  RTC_READINESS,
  RtcMisconfiguredError,
  RtcUnavailableError,
  type RtcNotReadyReason,
  type RtcReadinessProbe,
  type RtcReadinessReport,
} from '../domain/rtc-provider';

/** A report, and when the check that produced it began. */
interface Checked {
  readonly report: RtcReadinessReport;
  readonly at: Date;
}

/**
 * Whether the media provider is fit for a live session to start (live.md §9;
 * P7.1): its self-check, cached. The provider is asked at boot, at the start
 * of every room sweep (the reconciler's), and again whenever a caller finds
 * the last answer too old — Start asks for one no older than a room sweep
 * (`ensureFresh(ROOM_SWEEP_SECONDS * 1000)`) and answers 503, with nothing
 * stored, while it is not ready: `live.media_unavailable` when it is
 * unreachable or disabled, `live.media_misconfigured` otherwise (P7.2, Q-B).
 * Joins are not gated: a running session's room already exists.
 *
 * One check at a time: a refresh asked for while one runs shares it. A check
 * that throws — the port says it never does — counts as not ready: an outage
 * as `unreachable`, a configuration the provider refused as its own reason,
 * anything else as `incompatible_response`.
 *
 * `live.provider.health_check` is logged once per transition — when the
 * status or the reason changes, the first report included — with the status
 * and the reason only: never a URL, a key, a token or a provider message.
 */
@Injectable()
export class LiveMediaReadiness implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LiveMediaReadiness.name);
  private last: Checked | null = null;
  private running: Promise<RtcReadinessReport> | null = null;
  /** The state last logged: 'ready', or why not; null before the first report. */
  private logged: 'ready' | RtcNotReadyReason | null = null;

  constructor(
    @Inject(RTC_READINESS) private readonly probe: RtcReadinessProbe,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    // Not awaited: a slow or absent provider never holds the application's boot.
    void this.refresh();
  }

  async onModuleDestroy(): Promise<void> {
    await this.running;
  }

  /** The last report and when its check began; null before the first. */
  get current(): Checked | null {
    return this.last;
  }

  /** Asks the provider now — or joins the check already running. Never rejects. */
  refresh(): Promise<RtcReadinessReport> {
    if (this.running !== null) return this.running;
    const at = this.clock.now();
    const running = this.probe
      .check()
      .catch((error: unknown) => unexpected(error))
      .then((report) => {
        this.last = { report, at };
        this.note(report);
        return report;
      })
      .finally(() => {
        this.running = null;
      });
    this.running = running;
    return running;
  }

  /** The last report if its check began less than `maxAgeMs` ago; otherwise a fresh one. */
  async ensureFresh(maxAgeMs: number): Promise<RtcReadinessReport> {
    const last = this.last;
    if (last !== null && this.clock.now().getTime() - last.at.getTime() < maxAgeMs) {
      return last.report;
    }
    return this.refresh();
  }

  /** Logs a transition — never the same state twice in a row. */
  private note(report: RtcReadinessReport): void {
    const state = report.ready ? 'ready' : report.reason;
    if (state === this.logged) return;
    this.logged = state;
    if (report.ready) {
      this.logger.log(
        { event: 'live.provider.health_check', status: 'ready' },
        'the media provider is ready',
      );
      return;
    }
    const line = {
      event: 'live.provider.health_check',
      status: 'not_ready',
      reason: report.reason,
    };
    const message = 'the media provider is not ready; no live session can start';
    // Waiting fixes an outage, and a disabled provider is deliberate; the rest
    // is a misconfiguration an operator must fix.
    if (report.reason === 'unreachable' || report.reason === 'provider_disabled') {
      this.logger.warn(line, message);
    } else {
      this.logger.error(line, message);
    }
  }
}

function unexpected(error: unknown): RtcReadinessReport {
  if (error instanceof RtcUnavailableError) return { ready: false, reason: 'unreachable' };
  if (error instanceof RtcMisconfiguredError) return { ready: false, reason: error.reason };
  return { ready: false, reason: 'incompatible_response' };
}

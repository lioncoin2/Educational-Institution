/**
 * P8.3.5/P8.3.6/P8.4 — the controller's single aggregator and exact-participant
 * gate state (one instance, in the controller only; `workerId` is the global
 * shard index). Pure logic, unit-tested without forking: feed it worker
 * messages, ask whether the publisher phase is done (all publishers PUBLISHED),
 * whether the connection gate is met (EXACTLY requested connected, publishers
 * published, zero failures), or whether it is unreachable (any failure/crash →
 * abort; never hold with fewer). Media evidence lives in the `media` ledger.
 */
import { MediaLedger } from './media-ledger';
import {
  type PublisherState,
  type TeardownSummary,
  WORKER_EXIT_CODE,
  type WorkerMessage,
} from './types';

interface WorkerState {
  connected: number;
  failed: number;
  crashed: boolean;
  /** P8.3.8 teardown observations (result state; the lifecycle lives in worker.ts). */
  cleaned: boolean;
  teardownTimedOut: boolean;
  exit: { code: number | null; signal: string | null } | null;
  forced: boolean;
}

export class MpAggregator {
  private readonly workers = new Map<number, WorkerState>();
  private readonly publishedIds = new Set<string>();
  private readonly failedPublishIds = new Set<string>();
  private readonly publisherStates = new Map<string, PublisherState>();
  private readonly trackSids = new Map<string, string>();
  /** P8.4 media-delivery and transport evidence. */
  readonly media = new MediaLedger();

  constructor(
    private readonly requested: number,
    private readonly publishersRequired: number,
  ) {}

  private state(id: number): WorkerState {
    let s = this.workers.get(id);
    if (!s)
      this.workers.set(
        id,
        (s = {
          connected: 0,
          failed: 0,
          crashed: false,
          cleaned: false,
          teardownTimedOut: false,
          exit: null,
          forced: false,
        }),
      );
    return s;
  }

  /** The supervisor observed this worker process exit. */
  recordExit(workerId: number, code: number | null, signal: string | null): void {
    this.state(workerId).exit = { code, signal };
  }

  /** The supervisor SIGKILLed this worker at the shutdown grace deadline. */
  recordForcedKill(workerId: number): void {
    this.state(workerId).forced = true;
  }

  /**
   * How each owned worker process ended. Precedence: forced kill, then a clean
   * `cleaned` + exit 0, then a self-reported timeout; anything else is unclean.
   */
  teardownSummary(workerIds: readonly number[]): TeardownSummary {
    let cleaned = 0;
    let timedOut = 0;
    let exitedUnclean = 0;
    let forced = 0;
    for (const id of workerIds) {
      const s = this.state(id);
      if (s.forced) forced += 1;
      else if (s.cleaned && s.exit?.code === WORKER_EXIT_CODE.cleaned) cleaned += 1;
      else if (s.teardownTimedOut) timedOut += 1;
      else exitedUnclean += 1;
    }
    return { workers: workerIds.length, cleaned, timedOut, exitedUnclean, forced };
  }

  record(msg: WorkerMessage, at = Date.now()): void {
    const s = this.state(msg.workerId);
    if (this.media.record(msg, at)) return;
    switch (msg.type) {
      case 'connected':
        s.connected += 1;
        break;
      case 'failed':
        s.failed += 1;
        break;
      case 'published':
        this.publishedIds.add(msg.participantId);
        this.trackSids.set(msg.participantId, msg.trackSid);
        break;
      case 'publishFailed':
        this.failedPublishIds.add(msg.participantId);
        break;
      case 'publisherState':
        this.publisherStates.set(msg.participantId, msg.state);
        break;
      case 'fatal':
        s.crashed = true;
        break;
      case 'cleaned':
        s.cleaned = true;
        break;
      case 'teardownTimeout':
        s.teardownTimedOut = true;
        break;
      default:
        break; // ready/publishAttempt/teardownStarted: telemetry only
    }
  }

  /** The SID of a publisher's published track, as its worker reported it. */
  publishedTrackSid(participantId: string): string | undefined {
    return this.trackSids.get(participantId);
  }

  connected(): number {
    return this.sum((s) => s.connected);
  }
  failed(): number {
    return this.sum((s) => s.failed);
  }
  crashes(): number {
    return this.sum((s) => (s.crashed ? 1 : 0));
  }
  /** Worker ids that crashed (reported `fatal` or exited before shutdown). */
  crashedWorkers(): number[] {
    return [...this.workers.entries()].filter(([, s]) => s.crashed).map(([id]) => id);
  }
  publishersPublished(): number {
    return this.publishedIds.size;
  }
  publisherStateOf(id: string): PublisherState | undefined {
    return this.publisherStates.get(id);
  }

  /** Phase A done: every required publisher has published. */
  publishersReady(): boolean {
    return this.publishedIds.size >= this.publishersRequired;
  }

  /** Full gate: EXACTLY requested connected, zero failures/crashes, publishers published. */
  gateMet(): boolean {
    if (this.connected() !== this.requested) return false;
    if (this.failed() !== 0 || this.crashes() !== 0) return false;
    if (this.publishedIds.size !== this.publishersRequired) return false;
    return true;
  }

  /** The run can never reach exactly `requested` healthy participants. */
  unreachable(): { yes: boolean; reason: string } {
    if (this.crashes() > 0) return { yes: true, reason: `${this.crashes()} worker crash(es)` };
    if (this.failed() > 0)
      return { yes: true, reason: `${this.failed()} participant connect failure(s)` };
    if (this.failedPublishIds.size > 0) return { yes: true, reason: 'publisher failed to publish' };
    return { yes: false, reason: '' };
  }

  private sum(f: (s: WorkerState) => number): number {
    let n = 0;
    for (const s of this.workers.values()) n += f(s);
    return n;
  }
}

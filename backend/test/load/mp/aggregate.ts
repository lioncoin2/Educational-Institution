/**
 * P8.3.5 — the supervisor's aggregator and exact-participant gate. Pure logic,
 * unit-tested without forking: feed it worker messages, ask whether the gate is
 * met (EXACTLY the requested number connected, publisher published, zero
 * failures) or unreachable (any failure/crash → the run can never be the
 * requested N, so it must abort — never silently hold with fewer).
 */
import { type WorkerMessage } from './types';

interface WorkerState {
  connected: number;
  failed: number;
  publisherOk: boolean;
  publisherFail: boolean;
  crashed: boolean;
  rampDone: boolean;
}

export class MpAggregator {
  private readonly workers = new Map<number, WorkerState>();

  constructor(
    private readonly requested: number,
    private readonly publisherRequired: boolean,
  ) {}

  private state(id: number): WorkerState {
    let s = this.workers.get(id);
    if (!s)
      this.workers.set(
        id,
        (s = {
          connected: 0,
          failed: 0,
          publisherOk: false,
          publisherFail: false,
          crashed: false,
          rampDone: false,
        }),
      );
    return s;
  }

  record(msg: WorkerMessage): void {
    const s = this.state(msg.workerId);
    switch (msg.type) {
      case 'connected':
        s.connected += 1;
        break;
      case 'failed':
        s.failed += 1;
        break;
      case 'published':
        s.publisherOk = true;
        break;
      case 'publishFailed':
        s.publisherFail = true;
        break;
      case 'rampDone':
        s.rampDone = true;
        break;
      case 'fatal':
        s.crashed = true;
        break;
      default:
        break;
    }
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
  publisherPublished(): boolean {
    return [...this.workers.values()].some((s) => s.publisherOk);
  }
  private publisherFailed(): boolean {
    return [...this.workers.values()].some((s) => s.publisherFail);
  }

  /** EXACTLY requested connected, zero failures, publisher published if required. */
  gateMet(): boolean {
    if (this.connected() !== this.requested) return false;
    if (this.failed() !== 0 || this.crashes() !== 0) return false;
    if (this.publisherRequired && !this.publisherPublished()) return false;
    return true;
  }

  /** The run can never reach exactly `requested` healthy participants. */
  unreachable(): { yes: boolean; reason: string } {
    if (this.crashes() > 0) return { yes: true, reason: `${this.crashes()} worker crash(es)` };
    if (this.failed() > 0)
      return { yes: true, reason: `${this.failed()} participant connect failure(s)` };
    if (this.publisherRequired && this.publisherFailed())
      return { yes: true, reason: 'publisher failed to publish' };
    return { yes: false, reason: '' };
  }

  private sum(f: (s: WorkerState) => number): number {
    let n = 0;
    for (const s of this.workers.values()) n += f(s);
    return n;
  }
}

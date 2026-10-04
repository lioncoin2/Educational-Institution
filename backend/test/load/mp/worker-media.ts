/**
 * P8.4 — a worker's media OBSERVER (design §8). The worker (mp/worker.ts) owns
 * participant lifecycle; this module only watches the participants it is handed
 * and reports evidence: subscription, first packet, transport, faults, one
 * aggregated window per stats interval, publisher send progress and the sampled
 * 440 Hz content probe. Judgement is pure (mp/media-health.ts, observe/rules.ts);
 * this file holds the timers and the per-participant state.
 */
import { type MediaStatsSnapshot, type LoadParticipantLike, type ParticipantEvent } from './driver';
import { WindowAccumulator, classifyTransport, stepParticipant } from './media-health';
import { PROBE_TONE_HZ, blockToneRatio } from './tone-probe';
import { LOSS_BANDS, PROBE_MIN_TONE_RATIO } from '../observe/rules';
import { type Role } from '../core/identity';
import { type MediaFaultKind, type WorkerAssignment, type WorkerMessage } from './types';

const PROBE_CAPTURE_MS = 1_000;
const LAG_TICK_MS = 100;

interface Watched {
  readonly identity: string;
  readonly role: Role;
  readonly participant: LoadParticipantLike;
  subscribed: boolean;
  receiving: boolean;
  publisher: string | null;
  prev: MediaStatsSnapshot | null;
  transportKey: string | null;
}

export class WorkerMedia {
  private readonly watched: Watched[] = [];
  private readonly windows = new WindowAccumulator({
    green: LOSS_BANDS.green,
    red: LOSS_BANDS.red,
  });
  private timer: ReturnType<typeof setInterval> | null = null;
  private lagTimer: ReturnType<typeof setInterval> | null = null;
  private inRound = false;
  private probed = false;
  private closing = false;

  constructor(
    private readonly a: WorkerAssignment,
    private readonly emit: (msg: WorkerMessage) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.round(), this.a.statsIntervalMs);
    let expected = this.now() + LAG_TICK_MS;
    this.lagTimer = setInterval(() => {
      const t = this.now();
      this.windows.addLoopLag(Math.max(0, t - expected));
      expected = t + LAG_TICK_MS;
    }, LAG_TICK_MS);
  }

  /** Stops sampling; faults raised by the teardown itself are not reported. */
  stop(): void {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    if (this.lagTimer) clearInterval(this.lagTimer);
    this.timer = null;
    this.lagTimer = null;
  }

  watch(identity: string, role: Role, participant: LoadParticipantLike): void {
    const w: Watched = {
      identity,
      role,
      participant,
      subscribed: false,
      receiving: false,
      publisher: null,
      prev: null,
      transportKey: null,
    };
    this.watched.push(w);
    participant.onEvent((event) => this.onEvent(w, event));
  }

  private fault(w: Watched, fault: MediaFaultKind, reason: string | null = null): void {
    if (this.closing) return;
    this.emit({
      type: 'mediaFault',
      workerId: this.a.workerId,
      participantId: w.identity,
      fault,
      reason,
    });
  }

  private onEvent(w: Watched, e: ParticipantEvent): void {
    switch (e.kind) {
      case 'trackSubscribed':
        w.publisher = e.publisher;
        if (!w.subscribed) {
          w.subscribed = true;
          this.emit({
            type: 'subscribed',
            workerId: this.a.workerId,
            participantId: w.identity,
            trackSid: e.trackSid,
          });
          if (this.a.probe && !this.probed && w.role === 'listener') void this.probe(w);
        }
        return;
      case 'trackUnsubscribed':
        w.subscribed = false;
        return this.fault(w, 'unsubscribed');
      case 'trackSubscriptionFailed':
        return this.fault(w, 'subscriptionFailed', e.reason);
      case 'participantDisconnected':
        if (e.identity === w.publisher) this.fault(w, 'publisherGone');
        return;
      case 'disconnected':
        return this.fault(w, 'disconnected', e.reason);
      case 'reconnecting':
        return this.fault(w, 'reconnecting');
      case 'reconnected':
        return this.fault(w, 'reconnected');
    }
  }

  private async probe(w: Watched): Promise<void> {
    this.probed = true;
    const pcm = await w.participant.captureAudio(PROBE_CAPTURE_MS).catch(() => null);
    let ratio = 0;
    try {
      ratio = pcm ? blockToneRatio(pcm.samples, pcm.sampleRate, PROBE_TONE_HZ) : 0;
    } catch {
      ratio = 0; // an unusable capture (e.g. an invalid sample rate) is a failed probe
    }
    this.emit({
      type: 'probe',
      workerId: this.a.workerId,
      participantId: w.identity,
      ok: ratio >= PROBE_MIN_TONE_RATIO,
      toneRatio: ratio,
    });
  }

  /** One sampling round: every participant once, sequentially (natural staggering). */
  private async round(): Promise<void> {
    if (this.inRound || this.closing) return;
    this.inRound = true;
    try {
      for (const w of [...this.watched]) await this.sampleOne(w);
      const listeners = this.watched.filter((w) => w.role === 'listener').length;
      if (!this.closing)
        this.emit({
          type: 'mediaWindow',
          workerId: this.a.workerId,
          window: this.windows.flush(this.now(), listeners),
        });
    } finally {
      this.inRound = false;
    }
  }

  private async sampleOne(w: Watched): Promise<void> {
    const cur = await w.participant.stats().catch(() => null);
    if (this.closing) return;
    if (cur) this.reportTransport(w, cur);
    if (w.role !== 'listener') {
      if (cur?.outbound)
        this.emit({
          type: 'publisherStats',
          workerId: this.a.workerId,
          participantId: w.identity,
          t: cur.statsTsMs,
          packetsSent: cur.outbound.packetsSent,
        });
      return;
    }
    const step = stepParticipant(w.prev, cur, {
      windowMs: this.a.statsIntervalMs,
      nowMs: this.now(),
    });
    if (step.kind !== 'gap' && cur) w.prev = cur;
    if (!w.receiving && (cur?.inbound?.packetsReceived ?? 0) > 0) {
      w.receiving = true;
      this.emit({ type: 'receiving', workerId: this.a.workerId, participantId: w.identity });
    }
    if (step.kind === 'stall') this.fault(w, 'stall');
    this.windows.addStep(w.identity, step, { subscribed: w.subscribed, receiving: w.receiving });
  }

  private reportTransport(w: Watched, s: MediaStatsSnapshot): void {
    const report = classifyTransport(s);
    if (!report) return;
    const key = JSON.stringify(report);
    if (key === w.transportKey) return;
    w.transportKey = key;
    this.emit({ type: 'transport', workerId: this.a.workerId, participantId: w.identity, report });
  }
}

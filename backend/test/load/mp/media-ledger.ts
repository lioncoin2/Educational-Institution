/**
 * P8.4 — the media half of the controller's single aggregator (design §7, §8).
 * Pure state fed with worker messages: who is subscribed and receiving, every
 * participant's latest transport report, every media fault, each worker's
 * windows, the publisher's send progress and probe results. It decides nothing;
 * gates and rules read it.
 */
import {
  type MediaFaultKind,
  type MediaWindow,
  type TransportReport,
  type WorkerMessage,
} from './types';

export interface FaultRecord {
  readonly workerId: number;
  readonly participantId: string;
  readonly fault: MediaFaultKind;
  readonly reason: string | null;
  readonly at: number;
}

export interface WindowRecord {
  readonly workerId: number;
  readonly at: number;
  readonly window: MediaWindow;
}

export class MediaLedger {
  private readonly subscribedIds = new Set<string>();
  private readonly receivingIds = new Set<string>();
  private readonly transportById = new Map<string, TransportReport>();
  private readonly faultLog: FaultRecord[] = [];
  private readonly windowLog: WindowRecord[] = [];
  private readonly sent: Array<{ readonly t: number; readonly packetsSent: number }> = [];
  private readonly probeLog: Array<{
    readonly participantId: string;
    readonly ok: boolean;
    readonly toneRatio: number;
  }> = [];

  /** Records a media message; returns false for messages that are not media evidence. */
  record(msg: WorkerMessage, at: number): boolean {
    switch (msg.type) {
      case 'subscribed':
        this.subscribedIds.add(msg.participantId);
        return true;
      case 'receiving':
        this.receivingIds.add(msg.participantId);
        return true;
      case 'transport':
        this.transportById.set(msg.participantId, msg.report);
        return true;
      case 'mediaFault':
        if (msg.fault === 'unsubscribed') this.subscribedIds.delete(msg.participantId);
        this.faultLog.push({ ...msg, at });
        return true;
      case 'mediaWindow':
        this.windowLog.push({ workerId: msg.workerId, at, window: msg.window });
        return true;
      case 'publisherStats':
        this.sent.push({ t: msg.t, packetsSent: msg.packetsSent });
        return true;
      case 'probe':
        this.probeLog.push({
          participantId: msg.participantId,
          ok: msg.ok,
          toneRatio: msg.toneRatio,
        });
        return true;
      default:
        return false;
    }
  }

  subscribed(): number {
    return this.subscribedIds.size;
  }
  receiving(): number {
    return this.receivingIds.size;
  }
  transports(): ReadonlyMap<string, TransportReport> {
    return this.transportById;
  }
  faults(): readonly FaultRecord[] {
    return this.faultLog;
  }
  windows(): readonly WindowRecord[] {
    return this.windowLog;
  }
  /** The latest window of each worker received at or after `since`. */
  latestWindows(since: number): MediaWindow[] {
    const latest = new Map<number, WindowRecord>();
    for (const w of this.windowLog) if (w.at >= since) latest.set(w.workerId, w);
    return [...latest.values()].map((w) => w.window);
  }
  publisherSent(): ReadonlyArray<{ readonly t: number; readonly packetsSent: number }> {
    return this.sent;
  }
  probes(): ReadonlyArray<{
    readonly participantId: string;
    readonly ok: boolean;
    readonly toneRatio: number;
  }> {
    return this.probeLog;
  }
}

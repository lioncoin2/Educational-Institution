/**
 * P8.3.5 — structured multi-process event CSV. One row per worker event, keyed
 * by run/worker/participant so a run is fully reconstructable:
 *   run_id,worker_id,participant_id,t_ms,event,state
 * `state` carries the event's own payload (e.g. `publisherState=published`,
 * P8.3.8; `pair=udp host->host:7882`, `fault=stall`, P8.4) or else the
 * aggregate connected count at the moment (for a quick ramp curve). The row
 * formatter is pure; the writer appends to a file.
 */
import { appendFile, writeFile } from 'node:fs/promises';

import { type WorkerMessage } from './types';

export const EVENT_CSV_HEADER = 'run_id,worker_id,participant_id,t_ms,event,state';

/** Formats one event as a CSV row. Pure. */
export function eventRow(
  runId: string,
  msg: WorkerMessage,
  connectedTotal: number,
  now = Date.now(),
): string {
  const pid = 'participantId' in msg ? msg.participantId : 'worker';
  return [runId, msg.workerId, pid, now, msg.type, stateOf(msg, connectedTotal)].join(',');
}

/**
 * The `state` column: the event's own payload where it has one (the typed
 * PublisherState value, an attempt number, teardown counts, an error), else
 * the aggregate connected count at that moment. Observational only.
 */
function stateOf(msg: WorkerMessage, connectedTotal: number): string {
  switch (msg.type) {
    case 'failed':
    case 'publishFailed':
    case 'fatal':
      return `error:${sanitize(msg.error)}`;
    case 'publisherState':
      return `publisherState=${msg.state}`;
    case 'publishAttempt':
      return `attempt=${msg.attempt}`;
    case 'teardownStarted':
      return `participants=${msg.participants}`;
    case 'teardownTimeout':
      return `pending=${msg.pending}`;
    case 'published':
    case 'subscribed':
      return `track=${sanitize(msg.trackSid)}`;
    case 'transport': {
      const r = msg.report;
      return `pair=${sanitize(r.protocol)} ${r.localType}->${r.remoteType}:${r.remotePort ?? '-'} gathered=${r.localCandidateTypes.join('+')}`;
    }
    case 'mediaFault':
      return `fault=${msg.fault}${msg.reason ? ` reason=${sanitize(msg.reason)}` : ''}`;
    case 'mediaWindow': {
      const w = msg.window;
      return `listeners=${w.listeners} subscribed=${w.subscribed} receiving=${w.receiving} stalled=${w.stalled} gaps=${w.gaps} lost=${w.packetsLost} recv=${w.packetsReceived} lagP95=${w.loopLagMsP95}`;
    }
    case 'publisherStats':
      return `sent=${msg.packetsSent}`;
    case 'probe':
      return `toneRatio=${msg.toneRatio.toFixed(3)} ok=${msg.ok}`;
    default:
      return `connected=${connectedTotal}`;
  }
}

function sanitize(s: string): string {
  return s.replace(/[,\n\r]/g, ' ').slice(0, 80);
}

/** Appends event rows to a CSV file. */
export class EventCsv {
  constructor(private readonly path: string) {}

  async start(): Promise<void> {
    await writeFile(this.path, `${EVENT_CSV_HEADER}\n`, 'utf8');
  }

  async write(runId: string, msg: WorkerMessage, connectedTotal: number): Promise<void> {
    await appendFile(this.path, `${eventRow(runId, msg, connectedTotal)}\n`, 'utf8').catch(
      () => undefined,
    );
  }
}

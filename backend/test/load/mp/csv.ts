/**
 * P8.3.5 — structured multi-process event CSV. One row per worker event, keyed
 * by run/worker/participant so a run is fully reconstructable:
 *   run_id,worker_id,participant_id,t_ms,event,state
 * `state` carries the aggregate connected count at the moment (for a quick ramp
 * curve). The row formatter is pure; the writer appends to a file.
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
  const pid =
    'participantId' in msg ? msg.participantId : msg.type === 'cleaned' ? 'worker' : 'worker';
  const state =
    msg.type === 'failed' || msg.type === 'publishFailed' || msg.type === 'fatal'
      ? `error:${sanitize('error' in msg ? msg.error : '')}`
      : `connected=${connectedTotal}`;
  return [runId, msg.workerId, pid, now, msg.type, state].join(',');
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

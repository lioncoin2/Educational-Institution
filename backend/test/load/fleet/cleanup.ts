/**
 * P8.4 — deterministic cleanup and its verification (design §12), owned by the
 * controller and shared with the emergency `fleet-run cleanup --run <id>`.
 * Steps: delete the run room (loopback RoomService; an error is reported, not
 * swallowed), then VERIFY — no run or `loadtest-` room left, no participant on
 * the SFU, no load-test DB row, no generator process alive, no TURN relay
 * socket — then check host recovery against the verdict-table parameters
 * (P-rec-*). Unverifiable cleanup means `verified: false` (RED; the next rung
 * may not start). A recovery miss is re-checked once and is at most YELLOW.
 */
import { type RoomOps } from '../livekit/room-ops';
import { PARAMETERS } from '../observe/rules';
import { type HostSample } from '../observe/sample';

export interface CleanupDeps {
  readonly rooms: RoomOps;
  /** Read-only count of load-test rows (run inside the db container); null if unreadable. */
  readonly dbRows: () => Promise<number | null>;
  /** A fresh SUT sample, or null when no SUT sampler runs (local tests). */
  readonly sutSample: () => Promise<HostSample | null>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export interface CleanupInputs {
  readonly room: string;
  readonly baseline: HostSample | null;
  /** Live worker processes each agent reported after shutdown (null = no report). */
  readonly generatorProcesses: Readonly<Record<string, number | null>>;
  /** When the last participant was closed (start of the recovery wait). */
  readonly closedAt: number;
  /** Override the recovery wait (tests); defaults to P-rec-ct.afterSeconds. */
  readonly recoveryWaitMs?: number;
  readonly recheckMs?: number;
}

export interface CleanupReport {
  readonly cleanupRooms: number | null;
  readonly cleanupParticipants: number | null;
  readonly cleanupRows: number | null;
  readonly generatorProcesses: Readonly<Record<string, number | null>>;
  readonly relaySockets: number | null;
  readonly hostRecovered: { readonly conntrack: boolean | null; readonly cpu: boolean | null };
  readonly verified: boolean;
  readonly problems: readonly string[];
}

/** Conntrack recovered: ≤ baseline + max(fraction × baseline, absolute) (P-rec-ct). Pure. */
export function conntrackRecovered(baseline: number, now: number): boolean {
  const { fraction, absolute } = PARAMETERS['P-rec-ct'];
  return now <= baseline + Math.max(fraction * baseline, absolute);
}

export async function cleanupRun(d: CleanupDeps, i: CleanupInputs): Promise<CleanupReport> {
  const problems: string[] = [];
  await d.rooms.remove(i.room).catch((e: unknown) => {
    problems.push(`DeleteRoom failed: ${String((e as Error)?.message ?? e)}`);
  });
  const rooms = await d.rooms.loadtestRooms().catch(() => null);
  const cleanupRooms = rooms === null ? null : rooms.length;
  const cleanupParticipants = rooms === null ? null : rooms.reduce((n, r) => n + r.participants, 0);
  const cleanupRows = await d.dbRows();

  const wait = i.recoveryWaitMs ?? PARAMETERS['P-rec-ct'].afterSeconds * 1000;
  await d.sleep(Math.max(0, i.closedAt + wait - d.now()));
  let after = await d.sutSample();
  let ct = recovered(i.baseline, after);
  if (ct === false) {
    await d.sleep(i.recheckMs ?? PARAMETERS['P-rec-miss'].recheckSeconds * 1000);
    after = await d.sutSample();
    ct = recovered(i.baseline, after);
  }
  const relaySockets = after?.sut?.relaySockets ?? null;
  const turnTls = after?.sut?.turnTlsEstab ?? null;

  const zero = (v: number | null): boolean => v === 0;
  const generatorClean = Object.values(i.generatorProcesses).every(zero);
  if (!zero(cleanupRooms)) problems.push(`loadtest rooms left: ${cleanupRooms ?? 'unknown'}`);
  if (!zero(cleanupParticipants))
    problems.push(`participants left: ${cleanupParticipants ?? 'unknown'}`);
  if (!zero(cleanupRows)) problems.push(`load-test DB rows: ${cleanupRows ?? 'unknown'}`);
  if (!generatorClean) problems.push('generator processes left (or unreported)');
  if (after !== null && !zero(relaySockets))
    problems.push(`relay sockets: ${relaySockets ?? 'unknown'}`);
  if (after !== null && !zero(turnTls))
    problems.push(`TURN/TLS connections: ${turnTls ?? 'unknown'}`);
  return {
    cleanupRooms,
    cleanupParticipants,
    cleanupRows,
    generatorProcesses: i.generatorProcesses,
    relaySockets,
    hostRecovered: { conntrack: ct, cpu: null },
    verified: problems.length === 0,
    problems,
  };
}

function recovered(baseline: HostSample | null, after: HostSample | null): boolean | null {
  const b = baseline?.conntrack?.count;
  const a = after?.conntrack?.count;
  return b === undefined || a === undefined ? null : conntrackRecovered(b, a);
}

/**
 * P8.4 — post-rung LiveKit log analysis (design §9, §17 T3/T4; verdict table
 * M-unbound, V-dup, S-lk-err). LiveKit logs one JSON object per line
 * (`logging.json: true`, written to stderr). The controller reads the rung's
 * `--since/--until` window only AFTER the hold, so the analysis never loads the
 * SUT during measurement.
 *
 * A line belongs to the run when its `room` is the run room or its
 * `participant` identity carries the run prefix. A few lines carry neither:
 * `TURN allocation quota reached` names only the session's `participantID`.
 * Such lines are attributed through the participantIDs that the run's own lines
 * reveal (every session logs `starting RTC session` with room, identity and
 * ID), whatever their order. Counting is pure; readLivekitLog is the only I/O.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { type Readable } from 'node:stream';

export interface LivekitLogFilter {
  /** The run room, e.g. `loadtest-p84-<runId>`. */
  readonly room: string;
  /** The run identity prefix, e.g. `p84-<run8>-`. */
  readonly identityPrefix: string;
}

export interface LivekitLogCounts {
  /** `participant active` lines by server-side `connectionType`; `identities` is distinct (T3). */
  readonly participantActive: {
    readonly total: number;
    readonly udp: number;
    readonly tcp: number;
    readonly other: number;
    readonly identities: number;
  };
  /** `ice reconnected or switched pair` lines with a `relay` remote candidate in either pair (T3). */
  readonly relayPairs: number;
  /** `TURN allocation quota reached` (T4). */
  readonly turnQuota: number;
  /** `track not bound after timeout` (M-unbound). */
  readonly trackNotBound: number;
  /** `removing duplicate participant` (V-dup). */
  readonly duplicateParticipant: number;
  /** `level=error` lines (S-lk-err: evidence only). */
  readonly errorLines: number;
  /** Non-blank lines that are not a JSON object: unattributable, so counted for every filter. */
  readonly unparsedLines: number;
  /** Lines attributed to the run. */
  readonly matchedLines: number;
}

/** Incremental form of analyzeLivekitLog, so a streamed log is never buffered whole. */
export interface LivekitLogAnalyzer {
  add(line: string): void;
  /** The counts so far; does not consume state (callable repeatedly). */
  counts(): LivekitLogCounts;
}

const MSG = {
  active: 'participant active',
  switchedPair: 'ice reconnected or switched pair',
  turnQuota: 'TURN allocation quota reached',
  trackNotBound: 'track not bound after timeout',
  duplicate: 'removing duplicate participant',
} as const;

type LogRecord = Readonly<Record<string, unknown>>;

interface Tally {
  readonly active: { total: number; udp: number; tcp: number; other: number };
  readonly identities: Set<string>;
  relayPairs: number;
  turnQuota: number;
  trackNotBound: number;
  duplicateParticipant: number;
  errorLines: number;
  matchedLines: number;
}

export function createLivekitLogAnalyzer(filter: LivekitLogFilter): LivekitLogAnalyzer {
  if (filter.room === '' || filter.identityPrefix === '')
    throw new Error('livekit-log filter needs a non-empty room and identity prefix');
  const tally = emptyTally();
  /** participantIDs seen on the run's own lines. */
  const runSessions = new Set<string>();
  /** Lines naming only a participantID, resolved against runSessions at counts(). */
  const bySessionOnly: Array<{ readonly session: string; readonly record: LogRecord }> = [];
  let unparsedLines = 0;
  return {
    add(line) {
      if (line.trim() === '') return;
      const record = parseRecord(line);
      if (record === null) {
        unparsedLines += 1;
        return;
      }
      const session = text(record.participantID);
      const owner = ownerOf(record, filter);
      if (owner === 'run') {
        count(tally, record);
        if (session !== null) runSessions.add(session);
      } else if (owner === 'none' && session !== null) bySessionOnly.push({ session, record });
    },
    counts() {
      const total = cloneTally(tally);
      for (const { session, record } of bySessionOnly)
        if (runSessions.has(session)) count(total, record);
      return {
        participantActive: { ...total.active, identities: total.identities.size },
        relayPairs: total.relayPairs,
        turnQuota: total.turnQuota,
        trackNotBound: total.trackNotBound,
        duplicateParticipant: total.duplicateParticipant,
        errorLines: total.errorLines,
        unparsedLines,
        matchedLines: total.matchedLines,
      };
    },
  };
}

/** Counts a rung's LiveKit log lines that belong to the run (pure). */
export function analyzeLivekitLog(
  lines: Iterable<string>,
  filter: LivekitLogFilter,
): LivekitLogCounts {
  const analyzer = createLivekitLogAnalyzer(filter);
  for (const line of lines) analyzer.add(line);
  return analyzer.counts();
}

function parseRecord(line: string): LogRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return isRecord(value) ? value : null;
}

function ownerOf(record: LogRecord, filter: LivekitLogFilter): 'run' | 'other' | 'none' {
  const room = text(record.room);
  const identity = text(record.participant);
  if (room === filter.room || identity?.startsWith(filter.identityPrefix) === true) return 'run';
  return room === null && identity === null ? 'none' : 'other';
}

function count(tally: Tally, record: LogRecord): void {
  tally.matchedLines += 1;
  if (record.level === 'error') tally.errorLines += 1;
  switch (record.msg) {
    case MSG.active: {
      tally.active.total += 1;
      if (record.connectionType === 'udp') tally.active.udp += 1;
      else if (record.connectionType === 'tcp') tally.active.tcp += 1;
      else tally.active.other += 1;
      const identity = text(record.participant);
      if (identity !== null) tally.identities.add(identity);
      break;
    }
    case MSG.switchedPair:
      // The first selected pair is not logged, so a relay `existingPair` is evidence too.
      if (hasRelayRemote(record.newPair) || hasRelayRemote(record.existingPair))
        tally.relayPairs += 1;
      break;
    case MSG.turnQuota:
      tally.turnQuota += 1;
      break;
    case MSG.trackNotBound:
      tally.trackNotBound += 1;
      break;
    case MSG.duplicate:
      tally.duplicateParticipant += 1;
      break;
  }
}

function hasRelayRemote(pair: unknown): boolean {
  return isRecord(pair) && pair.remoteCandidateType === 'relay';
}

function emptyTally(): Tally {
  return {
    active: { total: 0, udp: 0, tcp: 0, other: 0 },
    identities: new Set(),
    relayPairs: 0,
    turnQuota: 0,
    trackNotBound: 0,
    duplicateParticipant: 0,
    errorLines: 0,
    matchedLines: 0,
  };
}

function cloneTally(tally: Tally): Tally {
  return { ...tally, active: { ...tally.active }, identities: new Set(tally.identities) };
}

function isRecord(value: unknown): value is LogRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The docker CLI gets an exact env allowlist (design §19), never the controller's env. */
const DOCKER_ENV_KEYS = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT'] as const;
/** Docker's container-name grammar; also keeps the name from being read as a flag. */
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** UTC RFC 3339 as Date.toISOString() prints it (docker would read a bare number as epoch). */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/**
 * The container's log lines in [since, until]: `docker logs` without a shell,
 * stdout and stderr each split by readline (lines never interleave mid-line)
 * and merged in arrival order. Rejects on invalid arguments, a spawn failure or
 * a non-zero exit; stopping early terminates the spawned child.
 */
export async function* readLivekitLog(
  container: string,
  sinceIso: string,
  untilIso: string,
): AsyncGenerator<string> {
  if (!CONTAINER_NAME.test(container)) throw new Error(`invalid container name: ${container}`);
  if (!ISO_UTC.test(sinceIso) || !ISO_UTC.test(untilIso))
    throw new Error('since/until must be UTC ISO-8601 timestamps');
  const child = spawn('docker', ['logs', '--since', sinceIso, '--until', untilIso, container], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: dockerEnv(),
  });
  const failure = new Promise<string | null>((resolve) => {
    child.once('error', (error) => resolve(`docker logs failed to start: ${error.message}`));
    child.once('close', (code, signal) =>
      resolve(code === 0 ? null : `docker logs exited with ${code ?? signal ?? 'unknown'}`),
    );
  });
  try {
    yield* mergeLines([child.stdout, child.stderr]);
    const reason = await failure;
    if (reason !== null) throw new Error(reason);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

async function* mergeLines(streams: readonly Readable[]): AsyncGenerator<string> {
  const sources: ReadonlyArray<AsyncIterator<string>> = streams.map((input) =>
    createInterface({ input, crlfDelay: Infinity })[Symbol.asyncIterator](),
  );
  const pull = (source: AsyncIterator<string>) =>
    source.next().then((result) => ({ source, result }));
  const pending = new Map(sources.map((source) => [source, pull(source)] as const));
  try {
    while (pending.size > 0) {
      const { source, result } = await Promise.race(pending.values());
      if (result.done === true) pending.delete(source);
      else {
        pending.set(source, pull(source));
        yield result.value;
      }
    }
  } finally {
    for (const source of sources) await source.return?.();
  }
}

function dockerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DOCKER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

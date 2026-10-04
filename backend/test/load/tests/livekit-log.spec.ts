import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeLivekitLog,
  createLivekitLogAnalyzer,
  readLivekitLog,
  type LivekitLogCounts,
  type LivekitLogFilter,
} from '../observe/livekit-log';

/**
 * Sanitized LiveKit v1.13.7 lines (shapes captured from the staging SUT's
 * loadtest rooms; long fields `<trimmed>`, addresses from documentation ranges).
 * `removing duplicate participant` never occurred on the SUT: that line is built
 * from LiveKit's participant-logger shape. Two runs share the window.
 */
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'livekit-log', 'rung.log'), 'utf8').split(
  '\n',
);
const RUN: LivekitLogFilter = {
  room: 'loadtest-p84-3f9c2a7b5d1e4f60',
  identityPrefix: 'p84-3f9c2a7b-',
};
const OTHER: LivekitLogFilter = {
  room: 'loadtest-p84-0a1b2c3d4e5f6071',
  identityPrefix: 'p84-0a1b2c3d-',
};

const ZERO: LivekitLogCounts = {
  participantActive: { total: 0, udp: 0, tcp: 0, other: 0, identities: 0 },
  relayPairs: 0,
  turnQuota: 0,
  trackNotBound: 0,
  duplicateParticipant: 0,
  errorLines: 0,
  unparsedLines: 0,
  matchedLines: 0,
};

const SESSION = {
  room: RUN.room,
  roomID: 'RM_runRoom0001',
  participant: 'p84-3f9c2a7b-L00007',
  participantID: 'PA_runL0000007',
  remote: false,
};
const line = (fields: Record<string, unknown>): string =>
  JSON.stringify({ level: 'info', ts: 1791190000.5, logger: 'livekit', ...fields });
const pair = (remoteCandidateType: string) => ({
  localProtocol: 'udp',
  localCandidateType: 'host',
  localPort: 7882,
  remoteProtocol: 'udp',
  remoteCandidateType,
  remotePort: 31070,
});
const switched = (existing: string, next: string): string =>
  line({
    msg: 'ice reconnected or switched pair',
    ...SESSION,
    transport: 'PUBLISHER',
    existingPair: pair(existing),
    newPair: pair(next),
  });

describe('LiveKit log analysis — fixture rung', () => {
  it('counts every run line: active by connection type, relay, quota, unbound, duplicate, errors', () => {
    expect(analyzeLivekitLog(FIXTURE, RUN)).toEqual({
      participantActive: { total: 4, udp: 3, tcp: 1, other: 0, identities: 3 },
      relayPairs: 1,
      turnQuota: 1,
      trackNotBound: 1,
      duplicateParticipant: 1,
      errorLines: 2,
      unparsedLines: 2,
      matchedLines: 18,
    });
  });

  it('excludes other rooms: the concurrent run counts only its own lines', () => {
    expect(analyzeLivekitLog(FIXTURE, OTHER)).toEqual({
      participantActive: { total: 1, udp: 1, tcp: 0, other: 0, identities: 1 },
      relayPairs: 1,
      turnQuota: 1,
      trackNotBound: 1,
      duplicateParticipant: 1,
      errorLines: 1,
      unparsedLines: 2,
      matchedLines: 7,
    });
  });

  it('attributes nothing to a run absent from the window (unparsed lines still counted)', () => {
    const absent = { room: 'loadtest-p84-ffffffffffffffff', identityPrefix: 'p84-ffffffff-' };
    expect(analyzeLivekitLog(FIXTURE, absent)).toEqual({ ...ZERO, unparsedLines: 2 });
  });

  it('the incremental analyzer matches the batch result and counts() does not consume state', () => {
    const analyzer = createLivekitLogAnalyzer(RUN);
    for (const l of FIXTURE) analyzer.add(l);
    expect(analyzer.counts()).toEqual(analyzeLivekitLog(FIXTURE, RUN));
    expect(analyzer.counts()).toEqual(analyzer.counts());
  });
});

describe('LiveKit log analysis — line rules', () => {
  it('counts malformed lines as unparsed, never as run lines; blank lines are ignored', () => {
    const lines = [
      `{"level":"error","room":"${RUN.room}","participant":"p84-3f9c2a7b-L00001"`,
      'error from daemon in stream: Error grabbing logs: unexpected EOF',
      '[]',
      'null',
      '',
      '   ',
    ];
    expect(analyzeLivekitLog(lines, RUN)).toEqual({ ...ZERO, unparsedLines: 4 });
  });

  it.each([
    {
      name: 'duplicate participant',
      lines: [line({ msg: 'removing duplicate participant', ...SESSION })],
      expected: { duplicateParticipant: 1, matchedLines: 1 },
    },
    {
      name: 'track not bound',
      lines: [line({ level: 'warn', msg: 'track not bound after timeout', ...SESSION })],
      expected: { trackNotBound: 1, matchedLines: 1 },
    },
    {
      name: 'relay remote candidate in the new pair',
      lines: [switched('prflx', 'relay')],
      expected: { relayPairs: 1, matchedLines: 1 },
    },
    {
      name: 'relay remote candidate in the existing pair only',
      lines: [switched('relay', 'host')],
      expected: { relayPairs: 1, matchedLines: 1 },
    },
    {
      name: 'TURN quota logged before the session line that attributes it',
      lines: [
        line({ msg: 'TURN allocation quota reached', participantID: SESSION.participantID }),
        line({ msg: 'starting RTC session', ...SESSION }),
      ],
      expected: { turnQuota: 1, matchedLines: 2 },
    },
  ])('detects $name', ({ lines, expected }) => {
    expect(analyzeLivekitLog(lines, RUN)).toEqual({ ...ZERO, ...expected });
  });

  it('a non-relay pair switch is matched but not a relay pair', () => {
    expect(analyzeLivekitLog([switched('prflx', 'host')], RUN)).toEqual({
      ...ZERO,
      matchedLines: 1,
    });
  });

  it('matches by identity prefix outside the run room and classifies non-udp/tcp as other', () => {
    const elsewhere = { ...SESSION, room: 'loadtest-p84-elsewhere' };
    const lines = [
      line({ msg: 'participant active', ...elsewhere, connectionType: 'turn' }),
      line({ msg: 'participant active', ...elsewhere }),
    ];
    expect(analyzeLivekitLog(lines, RUN)).toEqual({
      ...ZERO,
      participantActive: { total: 2, udp: 0, tcp: 0, other: 2, identities: 1 },
      matchedLines: 2,
    });
  });

  it('refuses a filter that would match every line', () => {
    expect(() => analyzeLivekitLog([], { room: RUN.room, identityPrefix: '' })).toThrow(
      /non-empty/,
    );
    expect(() => analyzeLivekitLog([], { room: '', identityPrefix: RUN.identityPrefix })).toThrow(
      /non-empty/,
    );
  });

  it('readLivekitLog is an async line source the analyzer can consume (type-level; never run)', () => {
    const source: (container: string, since: string, until: string) => AsyncIterable<string> =
      readLivekitLog;
    expect(typeof source).toBe('function');
  });
});

import { asId, type Result } from '../../../shared';
import { SNAPSHOT_CONNECTIONS } from '../contracts/vocabulary';
import {
  CLIENT_REQUEST_ID_INVALID,
  OBSERVATION_RULE,
  takeSnapshot,
  type AttendanceSnapshot,
  type SnapshotEntry,
  type TakeSnapshotInput,
} from './snapshot';

const STARTED = new Date('2026-01-01T00:00:00.000Z');
const OBSERVED = new Date('2026-01-01T00:00:02.000Z');
const NOW = new Date('2026-01-01T00:00:03.000Z');

function input(overrides: Partial<TakeSnapshotInput> = {}): TakeSnapshotInput {
  return {
    id: asId<'AttendanceSnapshot'>('snap-1'),
    communityId: 'c-1',
    liveSessionId: 'ls-1',
    hostUserId: 'host-1',
    recordedBy: 'rec-1',
    clientRequestId: 'req_ABCDEFGH',
    observationStartedAt: STARTED,
    observedAt: OBSERVED,
    now: NOW,
    entries: [],
    ...overrides,
  };
}

function unwrap(result: Result<AttendanceSnapshot>): AttendanceSnapshot {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

const entry = (userId: string, connection: SnapshotEntry['connection']): SnapshotEntry => ({
  userId,
  connection,
});

describe('takeSnapshot (attendance.md §6.1/§6.2) — the pure aggregate', () => {
  it('builds a snapshot, stamping the current observation rule and the given ids', () => {
    const snapshot = unwrap(takeSnapshot(input({ entries: [entry('u-1', 'CONNECTED')] })));
    expect(snapshot).toMatchObject({
      id: 'snap-1',
      communityId: 'c-1',
      liveSessionId: 'ls-1',
      hostUserId: 'host-1',
      recordedBy: 'rec-1',
      clientRequestId: 'req_ABCDEFGH',
      observationRule: 'provider_registry_v1',
      observationStartedAt: STARTED,
      observedAt: OBSERVED,
    });
    expect(snapshot.observationRule).toBe(OBSERVATION_RULE);
  });

  it('I1 — keeps one entry per account', () => {
    const snapshot = unwrap(
      takeSnapshot(input({ entries: [entry('u-1', 'CONNECTED'), entry('u-1', 'CONNECTED')] })),
    );
    expect(snapshot.entries).toEqual([{ userId: 'u-1', connection: 'CONNECTED' }]);
  });

  it('I1 — lets CONNECTED win over CONNECTING, whichever order they arrive', () => {
    const connectingFirst = unwrap(
      takeSnapshot(input({ entries: [entry('u-1', 'CONNECTING'), entry('u-1', 'CONNECTED')] })),
    );
    const connectedFirst = unwrap(
      takeSnapshot(input({ entries: [entry('u-1', 'CONNECTED'), entry('u-1', 'CONNECTING')] })),
    );
    expect(connectingFirst.entries).toEqual([{ userId: 'u-1', connection: 'CONNECTED' }]);
    expect(connectedFirst.entries).toEqual([{ userId: 'u-1', connection: 'CONNECTED' }]);
  });

  it('I2 — derives the counts from the entries, and they sum to the entry count', () => {
    const snapshot = unwrap(
      takeSnapshot(
        input({
          entries: [
            entry('u-1', 'CONNECTED'),
            entry('u-2', 'CONNECTING'),
            entry('u-3', 'CONNECTED'),
          ],
        }),
      ),
    );
    expect(snapshot.connectedCount).toBe(2);
    expect(snapshot.connectingCount).toBe(1);
    expect(snapshot.connectedCount + snapshot.connectingCount).toBe(snapshot.entries.length);
  });

  it('orders entries ascending by account id, whatever order they arrive', () => {
    const snapshot = unwrap(
      takeSnapshot(
        input({
          entries: [
            entry('u-3', 'CONNECTED'),
            entry('u-1', 'CONNECTED'),
            entry('u-2', 'CONNECTING'),
          ],
        }),
      ),
    );
    expect(snapshot.entries.map((e) => e.userId)).toEqual(['u-1', 'u-2', 'u-3']);
  });

  describe('I3 — recordedAt = max(now, observedAt), so observationStartedAt ≤ observedAt ≤ recordedAt', () => {
    it('takes now when the press is after the observation', () => {
      const snapshot = unwrap(takeSnapshot(input({ observedAt: OBSERVED, now: NOW })));
      expect(snapshot.recordedAt).toEqual(NOW);
      expect(snapshot.observationStartedAt.getTime()).toBeLessThanOrEqual(
        snapshot.observedAt.getTime(),
      );
      expect(snapshot.observedAt.getTime()).toBeLessThanOrEqual(snapshot.recordedAt.getTime());
    });

    it('clamps to observedAt when the clock reads earlier (a clock skew never inverts the order)', () => {
      const earlier = new Date('2026-01-01T00:00:01.000Z');
      const snapshot = unwrap(takeSnapshot(input({ observedAt: OBSERVED, now: earlier })));
      expect(snapshot.recordedAt).toEqual(OBSERVED);
      expect(snapshot.observedAt.getTime()).toBeLessThanOrEqual(snapshot.recordedAt.getTime());
    });
  });

  describe('a malformed clientRequestId is refused (validation → attendance.client_request_id_invalid)', () => {
    for (const bad of ['', 'short', 'bad key!', 'has/slash', 'a'.repeat(65)]) {
      it(`refuses ${JSON.stringify(bad)}`, () => {
        const result = takeSnapshot(input({ clientRequestId: bad }));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected a refusal');
        expect(result.error).toBe(CLIENT_REQUEST_ID_INVALID);
        expect(result.error.kind).toBe('validation');
        expect(result.error.code).toBe('attendance.client_request_id_invalid');
      });
    }

    for (const good of ['a'.repeat(8), 'A1_-b2c3', 'x'.repeat(64)]) {
      it(`accepts ${JSON.stringify(good)} at the length boundary`, () => {
        expect(takeSnapshot(input({ clientRequestId: good })).ok).toBe(true);
      });
    }
  });

  it('treats zero entries as a valid snapshot', () => {
    const snapshot = unwrap(takeSnapshot(input({ entries: [] })));
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.connectedCount).toBe(0);
    expect(snapshot.connectingCount).toBe(0);
  });

  it('I5 — produces a frozen, immutable snapshot (no mutator, no mutation path)', () => {
    const snapshot = unwrap(takeSnapshot(input({ entries: [entry('u-1', 'CONNECTED')] })));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(snapshot.entries.every((e) => Object.isFrozen(e))).toBe(true);
  });

  it('I6 — speaks only CONNECTED and CONNECTING; no present, absent, late or excused', () => {
    expect([...SNAPSHOT_CONNECTIONS]).toEqual(['CONNECTED', 'CONNECTING']);
    for (const word of ['present', 'absent', 'late', 'excused', 'PRESENT', 'ABSENT']) {
      expect(SNAPSHOT_CONNECTIONS as readonly string[]).not.toContain(word);
    }
    const snapshot = unwrap(
      takeSnapshot(input({ entries: [entry('u-1', 'CONNECTED'), entry('u-2', 'CONNECTING')] })),
    );
    for (const e of snapshot.entries) {
      expect(SNAPSHOT_CONNECTIONS as readonly string[]).toContain(e.connection);
    }
  });
});

import { sql } from 'drizzle-orm';

import { asId } from '../../src/shared';
import {
  takeSnapshot,
  type AttendanceSnapshot,
  type SnapshotEntry,
} from '../../src/modules/attendance/domain/snapshot';
import { DrizzleAttendanceSnapshotRepository } from '../../src/modules/attendance/infrastructure/drizzle-attendance-repository';
import type { Database } from '../../src/platform/database';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

interface BuildOpts {
  readonly id?: string;
  readonly communityId?: string;
  readonly liveSessionId?: string;
  readonly recordedBy?: string;
  readonly clientRequestId?: string;
  readonly observedAt?: Date;
  readonly entries?: readonly SnapshotEntry[];
}

function build(opts: BuildOpts = {}): AttendanceSnapshot {
  const result = takeSnapshot({
    id: asId<'AttendanceSnapshot'>(opts.id ?? 'snap-1'),
    communityId: opts.communityId ?? 'c-1',
    liveSessionId: opts.liveSessionId ?? 's-1',
    hostUserId: 'host-1',
    recordedBy: opts.recordedBy ?? 'rec-1',
    clientRequestId: opts.clientRequestId ?? 'req_AAAAAAAA',
    observationStartedAt: new Date('2026-01-01T00:00:00.000Z'),
    observedAt: opts.observedAt ?? new Date('2026-01-01T00:00:02.000Z'),
    now: new Date('2026-01-01T00:00:03.000Z'),
    entries: opts.entries ?? [{ userId: 'u-1', connection: 'CONNECTED' }],
  });
  if (!result.ok) throw new Error('build failed');
  return result.value;
}

describeWithPostgres('attendance snapshots in Postgres (attendance.md §7, §22)', () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let repo: DrizzleAttendanceSnapshotRepository;

  beforeAll(async () => {
    scratch = await scratchDatabase();
    db = scratch.db;
    repo = new DrizzleAttendanceSnapshotRepository(db);
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table attendance_snapshot_entries, attendance_snapshots`);
  });

  const countEntries = async (snapshotId: string): Promise<number> => {
    const rows = (
      await db.execute(
        sql`select count(*)::int as n from attendance_snapshot_entries where snapshot_id = ${snapshotId}`,
      )
    ).rows as { n: number }[];
    return rows[0]?.n ?? -1;
  };

  const violated = async (statement: ReturnType<typeof sql>): Promise<string> => {
    try {
      await db.execute(statement);
    } catch (error) {
      const cause = (error as { cause?: { constraint?: string } }).cause;
      return cause?.constraint ?? (error as { constraint?: string }).constraint ?? 'unknown';
    }
    return 'no violation';
  };

  describe('create and read', () => {
    it('stores a header and its entries, read back by key, id and entries', async () => {
      const snapshot = build({
        entries: [
          { userId: 'u-1', connection: 'CONNECTED' },
          { userId: 'u-2', connection: 'CONNECTING' },
        ],
      });
      expect(await repo.insert(snapshot)).toBe('created');

      expect(
        await repo.findByKey({
          liveSessionId: 's-1',
          recordedBy: 'rec-1',
          clientRequestId: 'req_AAAAAAAA',
        }),
      ).toMatchObject({ id: 'snap-1', connectedCount: 1, connectingCount: 1 });
      expect(await repo.findById('snap-1')).toMatchObject({ id: 'snap-1' });
      const entries = await repo.entries({ snapshotId: 'snap-1' }, { limit: 50 });
      expect(entries.items).toEqual([
        { userId: 'u-1', connection: 'CONNECTED' },
        { userId: 'u-2', connection: 'CONNECTING' },
      ]);
    });

    it('stores a zero-entry snapshot', async () => {
      expect(await repo.insert(build({ entries: [] }))).toBe('created');
      expect(await countEntries('snap-1')).toBe(0);
      expect(await repo.findById('snap-1')).toMatchObject({
        connectedCount: 0,
        connectingCount: 0,
      });
    });

    it('misses cleanly for an unknown key or id', async () => {
      expect(
        await repo.findByKey({ liveSessionId: 'x', recordedBy: 'y', clientRequestId: 'zzzzzzzz' }),
      ).toBeNull();
      expect(await repo.findById('nope')).toBeNull();
    });
  });

  describe('idempotency', () => {
    it('returns duplicate on a sequential replay of the same key', async () => {
      expect(await repo.insert(build({ id: 'snap-1' }))).toBe('created');
      expect(await repo.insert(build({ id: 'snap-1' }))).toBe('duplicate');
    });

    it('lets exactly one of two concurrent same-key inserts win', async () => {
      const winnerA = build({ id: 'A', entries: [{ userId: 'u-1', connection: 'CONNECTED' }] });
      const winnerB = build({ id: 'B', entries: [{ userId: 'u-2', connection: 'CONNECTED' }] });
      const outcomes = await Promise.all([repo.insert(winnerA), repo.insert(winnerB)]);
      expect([...outcomes].sort()).toEqual(['created', 'duplicate']);

      const stored = await repo.findByKey({
        liveSessionId: 's-1',
        recordedBy: 'rec-1',
        clientRequestId: 'req_AAAAAAAA',
      });
      expect(stored).not.toBeNull();
      const headers = (
        await db.execute(
          sql`select count(*)::int as n from attendance_snapshots where client_request_id = 'req_AAAAAAAA'`,
        )
      ).rows as { n: number }[];
      expect(headers[0]?.n).toBe(1); // exactly one header for the key
      expect(await countEntries(stored?.id ?? '')).toBe(1); // only the winner's entry
    });
  });

  describe('atomicity and chunking', () => {
    it('rolls back header and entries when an entry violates the primary key — nothing stored', async () => {
      const bad: AttendanceSnapshot = {
        ...build({ id: 'snap-bad', clientRequestId: 'req_BADBADBAD' }),
        entries: [
          { userId: 'dup', connection: 'CONNECTED' },
          { userId: 'dup', connection: 'CONNECTING' },
        ],
      };
      await expect(repo.insert(bad)).rejects.toThrow();
      expect(await repo.findById('snap-bad')).toBeNull(); // header rolled back
      expect(await countEntries('snap-bad')).toBe(0);
    });

    it('inserts 1,500 entries across chunks in one transaction', async () => {
      const entries: SnapshotEntry[] = Array.from({ length: 1_500 }, (_, i) => ({
        userId: `u-${String(i).padStart(5, '0')}`,
        connection: i % 2 === 0 ? 'CONNECTED' : 'CONNECTING',
      }));
      expect(
        await repo.insert(build({ id: 'big', clientRequestId: 'req_BIGBIGBIG', entries })),
      ).toBe('created');
      expect(await countEntries('big')).toBe(1_500);
      expect(await repo.findById('big')).toMatchObject({
        connectedCount: 750,
        connectingCount: 750,
      });
    });
  });

  describe('listing and pagination', () => {
    it('lists a community newest first, keyset-paged, ties broken by id', async () => {
      const at = new Date('2026-02-01T00:00:00.000Z');
      await repo.insert(
        build({
          id: 'a',
          clientRequestId: 'req_AAAAAAAA',
          observedAt: new Date('2026-02-01T00:00:01.000Z'),
        }),
      );
      await repo.insert(build({ id: 'b', clientRequestId: 'req_BBBBBBBB', observedAt: at }));
      await repo.insert(build({ id: 'c', clientRequestId: 'req_CCCCCCCC', observedAt: at }));

      const page1 = await repo.listByCommunity({ communityId: 'c-1' }, { limit: 2 });
      expect(page1.items.map((s) => s.id)).toEqual(['a', 'c']); // newest; then by id desc at the tie
      const page2 = await repo.listByCommunity(
        { communityId: 'c-1' },
        { limit: 2, cursor: page1.nextCursor },
      );
      expect(page2.items.map((s) => s.id)).toEqual(['b']);
      expect(page2.nextCursor).toBeUndefined();
    });

    it('filters the community list to one session', async () => {
      await repo.insert(build({ id: 'a', liveSessionId: 's-1', clientRequestId: 'req_AAAAAAAA' }));
      await repo.insert(build({ id: 'b', liveSessionId: 's-2', clientRequestId: 'req_BBBBBBBB' }));
      const listed = await repo.listByCommunity(
        { communityId: 'c-1', liveSessionId: 's-2' },
        { limit: 50 },
      );
      expect(listed.items.map((s) => s.id)).toEqual(['b']);
    });

    it('pages a snapshot’s entries ascending, and filters by connection', async () => {
      await repo.insert(
        build({
          entries: [
            { userId: 'u-3', connection: 'CONNECTED' },
            { userId: 'u-1', connection: 'CONNECTING' },
            { userId: 'u-2', connection: 'CONNECTED' },
          ],
        }),
      );
      const page1 = await repo.entries({ snapshotId: 'snap-1' }, { limit: 2 });
      expect(page1.items.map((e) => e.userId)).toEqual(['u-1', 'u-2']);
      const page2 = await repo.entries(
        { snapshotId: 'snap-1' },
        { limit: 2, cursor: page1.nextCursor },
      );
      expect(page2.items.map((e) => e.userId)).toEqual(['u-3']);
      const connected = await repo.entries(
        { snapshotId: 'snap-1', connection: 'CONNECTED' },
        { limit: 50 },
      );
      expect(connected.items.map((e) => e.userId)).toEqual(['u-2', 'u-3']);
    });
  });

  describe('recordedOrHostedInSession (the §11.3 view fallback read)', () => {
    // build() stamps hostUserId 'host-1' and recordedBy defaults to 'rec-1'.
    it('is false on an empty session, true for the recorder and for the session host', async () => {
      expect(await repo.recordedOrHostedInSession('s-1', 'rec-9')).toBe(false);
      await repo.insert(build({ id: 'a', liveSessionId: 's-1', recordedBy: 'rec-9' }));
      expect(await repo.recordedOrHostedInSession('s-1', 'rec-9')).toBe(true); // recorder
      expect(await repo.recordedOrHostedInSession('s-1', 'host-1')).toBe(true); // session host
      expect(await repo.recordedOrHostedInSession('s-1', 'stranger')).toBe(false); // neither
    });

    it('does not cross sessions, and stays true across several of the recorder’s snapshots', async () => {
      await repo.insert(
        build({
          id: 'a',
          liveSessionId: 's-1',
          recordedBy: 'rec-9',
          clientRequestId: 'req_AAAAAAAA',
        }),
      );
      await repo.insert(
        build({
          id: 'b',
          liveSessionId: 's-1',
          recordedBy: 'rec-9',
          clientRequestId: 'req_BBBBBBBB',
        }),
      );
      expect(await repo.recordedOrHostedInSession('s-1', 'rec-9')).toBe(true);
      expect(await repo.recordedOrHostedInSession('s-2', 'rec-9')).toBe(false); // other session
    });
  });

  describe('constraints and append-only', () => {
    const header = (over: Record<string, string> = {}) => {
      const v: Record<string, string> = {
        id: `'h1'`,
        community_id: `'c-1'`,
        live_session_id: `'s-1'`,
        host_user_id: `'host'`,
        recorded_by: `'rec'`,
        client_request_id: `'req_AAAAAAAA'`,
        observation_rule: `'provider_registry_v1'`,
        observation_started_at: `'2026-01-01T00:00:00Z'`,
        observed_at: `'2026-01-01T00:00:02Z'`,
        recorded_at: `'2026-01-01T00:00:03Z'`,
        connected_count: `1`,
        connecting_count: `0`,
        ...over,
      };
      return sql.raw(
        `insert into attendance_snapshots (id, community_id, live_session_id, host_user_id, recorded_by,
           client_request_id, observation_rule, observation_started_at, observed_at, recorded_at,
           connected_count, connecting_count)
         values (${v.id}, ${v.community_id}, ${v.live_session_id}, ${v.host_user_id}, ${v.recorded_by},
           ${v.client_request_id}, ${v.observation_rule}, ${v.observation_started_at}, ${v.observed_at},
           ${v.recorded_at}, ${v.connected_count}, ${v.connecting_count})`,
      );
    };

    it('enforces every CHECK and the named idempotency UNIQUE', async () => {
      expect(await violated(header({ client_request_id: `'short'` }))).toBe(
        'attendance_snapshots_client_request_id_shape',
      );
      expect(await violated(header({ observation_rule: `'provider_registry_v2'` }))).toBe(
        'attendance_snapshots_observation_rule_valid',
      );
      expect(await violated(header({ connected_count: `-1` }))).toBe(
        'attendance_snapshots_counts_non_negative',
      );
      expect(await violated(header({ observed_at: `'2025-12-31T00:00:00Z'` }))).toBe(
        'attendance_snapshots_time_order',
      );

      await db.execute(header({ id: `'ok'` })); // a valid header
      expect(await violated(header({ id: `'other'` }))).toBe(
        'attendance_snapshots_idempotency_unique',
      ); // same key
      // The entries' connection CHECK and PK.
      expect(
        await violated(
          sql.raw(
            `insert into attendance_snapshot_entries (snapshot_id, user_id, connection) values ('ok', 'u-1', 'PRESENT')`,
          ),
        ),
      ).toBe('attendance_snapshot_entries_connection_valid');
      await db.execute(
        sql.raw(
          `insert into attendance_snapshot_entries (snapshot_id, user_id, connection) values ('ok', 'u-1', 'CONNECTED')`,
        ),
      );
      expect(
        await violated(
          sql.raw(
            `insert into attendance_snapshot_entries (snapshot_id, user_id, connection) values ('ok', 'u-1', 'CONNECTING')`,
          ),
        ),
      ).toBe('attendance_snapshot_entries_snapshot_id_user_id_pk');
    });

    it('has exactly one foreign key, in-module (no key leaves attendance)', async () => {
      const fks = (
        await db.execute(sql`
          select conname, conrelid::regclass::text as child, confrelid::regclass::text as parent
          from pg_constraint
          where contype = 'f' and conrelid::regclass::text like 'attendance_%'`)
      ).rows as { conname: string; child: string; parent: string }[];
      expect(fks).toEqual([
        {
          conname: 'attendance_snapshot_entries_snapshot_fk',
          child: 'attendance_snapshot_entries',
          parent: 'attendance_snapshots',
        },
      ]);
    });

    it('keeps snapshots append-only: a referenced header cannot be deleted (ON DELETE RESTRICT)', async () => {
      await db.execute(header({ id: `'keep'` }));
      await db.execute(
        sql.raw(
          `insert into attendance_snapshot_entries (snapshot_id, user_id, connection) values ('keep', 'u-1', 'CONNECTED')`,
        ),
      );
      expect(await violated(sql`delete from attendance_snapshots where id = 'keep'`)).toBe(
        'attendance_snapshot_entries_snapshot_fk',
      );
    });
  });
});

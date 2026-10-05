import { asId } from '../../../shared';
import { takeSnapshot, type AttendanceSnapshot, type SnapshotEntry } from '../domain/snapshot';
import { InMemoryAttendanceSnapshotRepository } from './in-memory-attendance-repository';

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
    observationStartedAt: new Date(1_000),
    observedAt: opts.observedAt ?? new Date(2_000),
    now: new Date(3_000),
    entries: opts.entries ?? [{ userId: 'u-1', connection: 'CONNECTED' }],
  });
  if (!result.ok) throw new Error('build failed');
  return result.value;
}

/** A snapshot built directly (bypassing takeSnapshot's dedup), for the PK-parity check. */
function raw(id: string, entries: readonly SnapshotEntry[]): AttendanceSnapshot {
  return {
    id: asId<'AttendanceSnapshot'>(id),
    communityId: 'c-1',
    liveSessionId: 's-1',
    hostUserId: 'host-1',
    recordedBy: 'rec-1',
    clientRequestId: 'req_RAWRAWRAW',
    observationRule: 'provider_registry_v1',
    observationStartedAt: new Date(1_000),
    observedAt: new Date(2_000),
    recordedAt: new Date(3_000),
    connectedCount: entries.filter((e) => e.connection === 'CONNECTED').length,
    connectingCount: entries.filter((e) => e.connection === 'CONNECTING').length,
    entries,
  };
}

describe('InMemoryAttendanceSnapshotRepository', () => {
  let repo: InMemoryAttendanceSnapshotRepository;
  beforeEach(() => {
    repo = new InMemoryAttendanceSnapshotRepository();
  });

  it('creates a snapshot and reads it back by key and by id (headers, no entries)', async () => {
    const snapshot = build({ entries: [{ userId: 'u-1', connection: 'CONNECTED' }] });
    expect(await repo.insert(snapshot)).toBe('created');

    const byKey = await repo.findByKey({
      liveSessionId: 's-1',
      recordedBy: 'rec-1',
      clientRequestId: 'req_AAAAAAAA',
    });
    const byId = await repo.findById('snap-1');
    expect(byKey).toMatchObject({ id: 'snap-1', connectedCount: 1, connectingCount: 0 });
    expect(byId).toEqual(byKey);
    expect(byKey).not.toHaveProperty('entries');
  });

  it('accepts a zero-entry snapshot', async () => {
    expect(await repo.insert(build({ entries: [] }))).toBe('created');
    expect(await repo.findById('snap-1')).toMatchObject({ connectedCount: 0, connectingCount: 0 });
    expect(await repo.entries({ snapshotId: 'snap-1' }, { limit: 50 })).toEqual({ items: [] });
  });

  it('misses cleanly for an unknown key or id', async () => {
    expect(
      await repo.findByKey({ liveSessionId: 'x', recordedBy: 'y', clientRequestId: 'zzzzzzzz' }),
    ).toBeNull();
    expect(await repo.findById('nope')).toBeNull();
  });

  it('returns duplicate on a sequential replay of the same key, leaving the stored snapshot unchanged', async () => {
    expect(await repo.insert(build({ id: 'snap-1' }))).toBe('created');
    expect(await repo.insert(build({ id: 'snap-1' }))).toBe('duplicate');
    expect(
      await repo.findByKey({
        liveSessionId: 's-1',
        recordedBy: 'rec-1',
        clientRequestId: 'req_AAAAAAAA',
      }),
    ).toMatchObject({ id: 'snap-1' });
  });

  it('on the same key with a different id (a concurrent loser), keeps the first and reports duplicate', async () => {
    expect(await repo.insert(build({ id: 'winner' }))).toBe('created');
    expect(await repo.insert(build({ id: 'loser' }))).toBe('duplicate');
    expect(
      await repo.findByKey({
        liveSessionId: 's-1',
        recordedBy: 'rec-1',
        clientRequestId: 'req_AAAAAAAA',
      }),
    ).toMatchObject({ id: 'winner' });
    expect(await repo.findById('loser')).toBeNull();
  });

  it('faults on a primary-key collision (same id, different key) — never swallowed as duplicate', async () => {
    await repo.insert(build({ id: 'snap-1', clientRequestId: 'req_AAAAAAAA' }));
    await expect(
      repo.insert(build({ id: 'snap-1', clientRequestId: 'req_BBBBBBBB' })),
    ).rejects.toThrow();
  });

  it('faults on a snapshot carrying two entries for one account', async () => {
    await expect(
      repo.insert(
        raw('snap-raw', [
          { userId: 'u-1', connection: 'CONNECTED' },
          { userId: 'u-1', connection: 'CONNECTING' },
        ]),
      ),
    ).rejects.toThrow();
  });

  it('exposes no update or delete path (append-only)', () => {
    const api = repo as unknown as Record<string, unknown>;
    for (const name of ['update', 'delete', 'remove', 'amend', 'void']) {
      expect(typeof api[name]).toBe('undefined');
    }
  });

  it('lists a community newest first, keyset-paged, ties broken by id', async () => {
    await repo.insert(
      build({ id: 'a', clientRequestId: 'req_AAAAAAAA', observedAt: new Date(1_000) }),
    );
    await repo.insert(
      build({ id: 'b', clientRequestId: 'req_BBBBBBBB', observedAt: new Date(3_000) }),
    );
    await repo.insert(
      build({ id: 'c', clientRequestId: 'req_CCCCCCCC', observedAt: new Date(2_000) }),
    );

    const page1 = await repo.listByCommunity({ communityId: 'c-1' }, { limit: 2 });
    expect(page1.items.map((s) => s.id)).toEqual(['b', 'c']); // newest first
    expect(page1.nextCursor).toBeDefined();

    const page2 = await repo.listByCommunity(
      { communityId: 'c-1' },
      { limit: 2, cursor: page1.nextCursor },
    );
    expect(page2.items.map((s) => s.id)).toEqual(['a']);
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

  it('pages a snapshot’s entries ascending by account id, and filters by connection', async () => {
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

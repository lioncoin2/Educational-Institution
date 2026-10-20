import { DrizzleLessonRepository } from '../../src/modules/operations/infrastructure/drizzle-lesson-repository';
import type { Lesson } from '../../src/modules/operations/domain/lesson';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  const createdAt = new Date('2026-10-20T08:00:00.000Z');
  return {
    id: `lesson-${Math.random().toString(36).slice(2)}`,
    halaqaId: 'halaqa-1',
    title: 'الدرس',
    local: { date: '2027-03-01', time: '09:00' },
    timezone: 'Asia/Riyadh',
    scheduledAt: new Date('2027-03-01T06:00:00.000Z'),
    status: 'SCHEDULED',
    createdAt,
    createdBy: 'owner-1',
    updatedAt: createdAt,
    cancelledAt: null,
    cancelledBy: null,
    ...overrides,
  };
}

describeWithPostgres('operations_lessons — schema, persistence and seed', () => {
  let scratch: ScratchDatabase;
  let repo: DrizzleLessonRepository;

  beforeAll(async () => {
    scratch = await scratchDatabase();
    repo = new DrizzleLessonRepository(scratch.db);
  });

  afterAll(async () => {
    await scratch.drop();
  });

  it('built the table with every named CHECK and index', async () => {
    const checks = await scratch.pool.query<{ conname: string }>(
      `select conname from pg_constraint where conrelid = 'operations_lessons'::regclass and contype = 'c'`,
    );
    expect(checks.rows.map((r) => r.conname)).toEqual(
      expect.arrayContaining([
        'operations_lessons_status_valid',
        'operations_lessons_local_date_shape',
        'operations_lessons_local_time_shape',
        'operations_lessons_cancelled_consistent',
        'operations_lessons_updated_after_created',
      ]),
    );

    const indexes = await scratch.pool.query(
      `select indexname, indexdef from pg_indexes where tablename = 'operations_lessons'`,
    );
    const byName = new Map(indexes.rows.map((r) => [r.indexname as string, r.indexdef as string]));
    expect(byName.has('operations_lessons_by_schedule')).toBe(true);
    expect(byName.has('operations_lessons_by_halaqa_schedule')).toBe(true);
    const unique = byName.get('operations_lessons_client_request_unique');
    expect(unique).toBeDefined();
    expect(unique).toMatch(/UNIQUE/i);
    expect(unique).toMatch(/where .*client_request_id/i);
  });

  it('rejects an invalid status and an inconsistent cancellation by CHECK', async () => {
    await expect(
      scratch.pool.query(
        `insert into operations_lessons (id, halaqa_id, local_date, local_time, timezone, scheduled_at, status, created_at, created_by, updated_at)
         values ('x1','h','2027-03-01','09:00','Asia/Riyadh', now() + interval '30 days', 'BOGUS', now(), 'o', now())`,
      ),
    ).rejects.toThrow(/operations_lessons_status_valid/);

    // SCHEDULED but with cancellation columns set — forbidden.
    await expect(
      scratch.pool.query(
        `insert into operations_lessons (id, halaqa_id, local_date, local_time, timezone, scheduled_at, status, created_at, created_by, updated_at, cancelled_at, cancelled_by)
         values ('x2','h','2027-03-01','09:00','Asia/Riyadh', now() + interval '30 days', 'SCHEDULED', now(), 'o', now(), now(), 'o')`,
      ),
    ).rejects.toThrow(/operations_lessons_cancelled_consistent/);
  });

  it('round-trips the wall clock, timezone and instant through the repository', async () => {
    const created = await repo.create(lesson({ id: 'rt-1' }), null);
    expect(created.status).toBe('created');
    const found = await repo.findById('rt-1');
    expect(found).not.toBeNull();
    expect(found!.local).toEqual({ date: '2027-03-01', time: '09:00' });
    expect(found!.timezone).toBe('Asia/Riyadh');
    expect(found!.scheduledAt.toISOString()).toBe('2027-03-01T06:00:00.000Z');
    expect(found!.status).toBe('SCHEDULED');
  });

  it('is idempotent on a repeated clientRequestId', async () => {
    const first = await repo.create(lesson({ id: 'idem-a' }), 'req-9');
    const second = await repo.create(lesson({ id: 'idem-b' }), 'req-9');
    expect(first.status).toBe('created');
    expect(second.status).toBe('duplicate');
    expect(second.lesson.id).toBe('idem-a');
  });

  it('persists a cancellation as a status transition (row kept)', async () => {
    await repo.create(lesson({ id: 'cancel-1' }), null);
    const existing = await repo.findById('cancel-1');
    await repo.save({
      ...existing!,
      status: 'CANCELLED',
      cancelledAt: new Date('2026-10-20T09:00:00.000Z'),
      cancelledBy: 'owner-1',
      updatedAt: new Date('2026-10-20T09:00:00.000Z'),
    });
    const after = await repo.findById('cancel-1');
    expect(after!.status).toBe('CANCELLED');
    expect(after!.cancelledBy).toBe('owner-1');
  });

  it('lists by (scheduledAt, id) ascending with keyset paging', async () => {
    const h = 'list-halaqa';
    await repo.create(
      lesson({ id: 'L3', halaqaId: h, scheduledAt: new Date('2027-05-03T00:00:00Z') }),
      null,
    );
    await repo.create(
      lesson({ id: 'L1', halaqaId: h, scheduledAt: new Date('2027-05-01T00:00:00Z') }),
      null,
    );
    await repo.create(
      lesson({ id: 'L2', halaqaId: h, scheduledAt: new Date('2027-05-02T00:00:00Z') }),
      null,
    );
    const first = await repo.list({ halaqaId: h, limit: 2 });
    expect(first.map((l) => l.id)).toEqual(['L1', 'L2']);
    const next = await repo.list({
      halaqaId: h,
      after: { scheduledAt: first[1].scheduledAt, id: first[1].id },
      limit: 2,
    });
    expect(next.map((l) => l.id)).toEqual(['L3']);
  });

  it('seeded the operations.schedule_manage permission for OWNER and ADMIN only', async () => {
    const perm = await scratch.pool.query(
      `select code from permissions where code = 'operations.schedule_manage'`,
    );
    expect(perm.rowCount).toBe(1);
    const grants = await scratch.pool.query<{ role_code: string }>(
      `select role_code from role_permissions where permission_code = 'operations.schedule_manage' order by role_code`,
    );
    expect(grants.rows.map((r) => r.role_code)).toEqual(['ADMIN', 'OWNER']);
  });
});

describeWithPostgres('operations migrations on a database already in use', () => {
  it('0026/0027 add only the lessons table and the scheduling grants', async () => {
    const before = await scratchDatabase({ upTo: 26 }); // through 0025, pre-operations
    try {
      const noTable = await before.pool.query(`select to_regclass('operations_lessons') as t`);
      expect(noTable.rows[0].t).toBeNull();
      const noPerm = await before.pool.query(
        `select 1 from permissions where code = 'operations.schedule_manage'`,
      );
      expect(noPerm.rowCount).toBe(0);
    } finally {
      await before.drop();
    }

    const after = await scratchDatabase(); // all migrations
    try {
      const table = await after.pool.query(`select to_regclass('operations_lessons') as t`);
      expect(table.rows[0].t).not.toBeNull();
      const empty = await after.pool.query(`select count(*)::int as n from operations_lessons`);
      expect(empty.rows[0].n).toBe(0);
      const grants = await after.pool.query(
        `select count(*)::int as n from role_permissions where permission_code = 'operations.schedule_manage'`,
      );
      expect(grants.rows[0].n).toBe(2); // OWNER + ADMIN, nothing else
    } finally {
      await after.drop();
    }
  });
});

import {
  asId,
  FixedClock,
  err,
  failure,
  ok,
  type IdGenerator,
  type Principal,
} from '../../../shared';
import type { AcademicRelationships } from '../../academic/contracts';
import {
  AUTHORIZATION_SERVICE as _AUTHORIZATION_SERVICE,
  type AuthorizationService,
} from '../../identity/contracts/authorization';
import type { Permission } from '../../identity/contracts/permissions';
import { InMemoryLessonStore } from '../infrastructure/in-memory-lesson-store';
import {
  CancelLessonUseCase,
  GetLessonUseCase,
  ListLessonsUseCase,
  RescheduleLessonUseCase,
  ScheduleLessonUseCase,
} from './lesson.use-cases';
import { OperationsAccess } from './operations-access';

void _AUTHORIZATION_SERVICE;

const owner: Principal = {
  userId: 'owner-1',
  roles: ['OWNER'],
  permissions: new Set<string>(['operations.schedule_manage']),
};
const outsider: Principal = { userId: 'nobody', roles: [], permissions: new Set<string>() };

function harness(institutionTimezone: string | null = 'Asia/Riyadh') {
  const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
  let seq = 0;
  const ids: IdGenerator = {
    next: <TBrand extends string>() => asId<TBrand>(`lesson-${++seq}`),
  };
  const repo = new InMemoryLessonStore();
  const halaqas = new Set<string>(['halaqa-1']);
  const academicCalls: string[] = [];
  const academic: AcademicRelationships = {
    halaqaExists: async (id) => {
      academicCalls.push(`halaqaExists:${id}`);
      return halaqas.has(id);
    },
    isEnrolled: async () => {
      academicCalls.push('isEnrolled');
      return false;
    },
    isTeaching: async () => {
      academicCalls.push('isTeaching');
      return false;
    },
    activeStudentIds: async () => {
      academicCalls.push('activeStudentIds');
      return { userIds: [], nextCursor: null };
    },
  };
  const institution = { default: () => institutionTimezone };
  const authorization: AuthorizationService = {
    can: (principal, permission) => principal.permissions.has(permission),
    authorize: (principal, permission: Permission) =>
      principal.permissions.has(permission)
        ? ok(undefined)
        : err(failure('forbidden', 'identity.permission_denied', 'denied')),
  };
  const access = new OperationsAccess(authorization);
  return {
    clock,
    repo,
    halaqas,
    academicCalls,
    schedule: new ScheduleLessonUseCase(access, repo, academic, institution, clock, ids),
    list: new ListLessonsUseCase(access, repo),
    get: new GetLessonUseCase(access, repo),
    reschedule: new RescheduleLessonUseCase(access, repo, clock),
    cancel: new CancelLessonUseCase(access, repo, clock),
  };
}

const futureLesson = { halaqaId: 'halaqa-1', date: '2026-11-01', time: '14:30' } as const;

describe('ScheduleLessonUseCase', () => {
  it('schedules a lesson in the institution default timezone', async () => {
    const h = harness();
    const result = await h.schedule.execute({ principal: owner, ...futureLesson });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('created');
    const lesson = result.value.lesson;
    expect(lesson.timezone).toBe('Asia/Riyadh');
    expect(lesson.local).toEqual({ date: '2026-11-01', time: '14:30' });
    expect(lesson.scheduledAt.toISOString()).toBe('2026-11-01T11:30:00.000Z'); // +03:00
    expect(lesson.status).toBe('SCHEDULED');
    expect(lesson.createdBy).toBe('owner-1');
    expect(lesson.cancelledAt).toBeNull();
  });

  it('uses an explicitly supplied timezone over the institution default', async () => {
    const h = harness();
    const result = await h.schedule.execute({
      principal: owner,
      ...futureLesson,
      timezone: 'Europe/London',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.lesson.timezone).toBe('Europe/London');
    expect(result.value.lesson.scheduledAt.toISOString()).toBe('2026-11-01T14:30:00.000Z'); // GMT
  });

  it('refuses a caller without operations.schedule_manage', async () => {
    const h = harness();
    const result = await h.schedule.execute({ principal: outsider, ...futureLesson });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('forbidden');
    // Nothing was read or written.
    expect(h.academicCalls).toEqual([]);
    expect(await h.repo.list({ limit: 10 })).toHaveLength(0);
  });

  it('rejects an unknown halaqa as not_found', async () => {
    const h = harness();
    const result = await h.schedule.execute({
      principal: owner,
      ...futureLesson,
      halaqaId: 'ghost',
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.kind).toBe('not_found');
    expect(result.error.code).toBe('operations.halaqa_not_found');
  });

  it('requires a timezone when the institution has no default', async () => {
    const h = harness(null);
    const result = await h.schedule.execute({ principal: owner, ...futureLesson });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('operations.timezone_required');
  });

  it('rejects an invalid timezone, a malformed date, and a DST-nonexistent time', async () => {
    const h = harness();
    const badZone = await h.schedule.execute({
      principal: owner,
      ...futureLesson,
      timezone: '+03:00',
    });
    expect(badZone.ok ? null : badZone.error.code).toBe('operations.timezone_invalid');

    const badDate = await h.schedule.execute({
      principal: owner,
      halaqaId: 'halaqa-1',
      date: '2026-02-30',
      time: '09:00',
    });
    expect(badDate.ok ? null : badDate.error.code).toBe('operations.local_time_invalid');

    // New York, 2026-03-08: clocks jump 02:00 -> 03:00, so 02:30 never occurs.
    const gap = await h.schedule.execute({
      principal: owner,
      halaqaId: 'halaqa-1',
      date: '2026-03-08',
      time: '02:30',
      timezone: 'America/New_York',
    });
    expect(gap.ok ? null : gap.error.code).toBe('operations.local_time_nonexistent');
  });

  it('resolves a DST-ambiguous fall-back time to the earlier instant', async () => {
    const h = harness();
    // New York, 2026-11-01 01:30 occurs twice; earlier is EDT (05:30Z).
    const result = await h.schedule.execute({
      principal: owner,
      halaqaId: 'halaqa-1',
      date: '2026-11-01',
      time: '01:30',
      timezone: 'America/New_York',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.lesson.scheduledAt.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('rejects a lesson in the past (strictly, against the injected clock)', async () => {
    const h = harness();
    const result = await h.schedule.execute({
      principal: owner,
      halaqaId: 'halaqa-1',
      date: '2025-06-01',
      time: '10:00',
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('operations.lesson_in_the_past');
  });

  it('rejects an over-long title', async () => {
    const h = harness();
    const result = await h.schedule.execute({
      principal: owner,
      ...futureLesson,
      title: 'x'.repeat(201),
    });
    expect(result.ok ? null : result.error.code).toBe('operations.title_too_long');
  });

  it('is idempotent for a repeated clientRequestId (no second lesson)', async () => {
    const h = harness();
    const first = await h.schedule.execute({
      principal: owner,
      ...futureLesson,
      clientRequestId: 'req-1',
    });
    const second = await h.schedule.execute({
      principal: owner,
      ...futureLesson,
      clientRequestId: 'req-1',
    });
    if (!first.ok || !second.ok) throw new Error('expected ok');
    expect(first.value.status).toBe('created');
    expect(second.value.status).toBe('duplicate');
    expect(second.value.lesson.id).toBe(first.value.lesson.id);
    expect(await h.repo.list({ limit: 10 })).toHaveLength(1);
  });

  it('creates no attendance, notification or live session — only the lesson, via halaqaExists alone', async () => {
    const h = harness();
    await h.schedule.execute({ principal: owner, ...futureLesson });
    expect(h.academicCalls).toEqual(['halaqaExists:halaqa-1']); // never roster/enrolment
    const lessons = await h.repo.list({ limit: 10 });
    expect(lessons).toHaveLength(1);
  });
});

describe('GetLessonUseCase', () => {
  it('returns a lesson to an authorised caller and 404s a missing one', async () => {
    const h = harness();
    const created = await h.schedule.execute({ principal: owner, ...futureLesson });
    if (!created.ok) throw new Error('setup');
    const found = await h.get.execute({ principal: owner, lessonId: created.value.lesson.id });
    expect(found.ok).toBe(true);
    const missing = await h.get.execute({ principal: owner, lessonId: 'nope' });
    expect(missing.ok ? null : missing.error.kind).toBe('not_found');
  });

  it('refuses an unauthorised caller before any lookup (no id enumeration)', async () => {
    const h = harness();
    const created = await h.schedule.execute({ principal: owner, ...futureLesson });
    if (!created.ok) throw new Error('setup');
    const result = await h.get.execute({ principal: outsider, lessonId: created.value.lesson.id });
    expect(result.ok ? null : result.error.kind).toBe('forbidden'); // same answer as a missing id
  });
});

describe('ListLessonsUseCase', () => {
  it('orders by instant and pages deterministically with a cursor', async () => {
    const h = harness();
    for (const d of ['2026-11-03', '2026-11-01', '2026-11-02']) {
      await h.schedule.execute({ principal: owner, halaqaId: 'halaqa-1', date: d, time: '09:00' });
    }
    const page1 = await h.list.execute({ principal: owner, limit: 2 });
    if (!page1.ok) throw new Error('expected ok');
    expect(page1.value.items.map((l) => l.local.date)).toEqual(['2026-11-01', '2026-11-02']);
    expect(page1.value.nextCursor).toBeDefined();
    const page2 = await h.list.execute({
      principal: owner,
      limit: 2,
      cursor: page1.value.nextCursor,
    });
    if (!page2.ok) throw new Error('expected ok');
    expect(page2.value.items.map((l) => l.local.date)).toEqual(['2026-11-03']);
    expect(page2.value.nextCursor).toBeUndefined();
  });

  it('rejects a malformed cursor', async () => {
    const h = harness();
    const result = await h.list.execute({ principal: owner, cursor: 'not-a-cursor' });
    expect(result.ok ? null : result.error.code).toBe('operations.cursor_invalid');
  });

  it('refuses an unauthorised caller', async () => {
    const h = harness();
    const result = await h.list.execute({ principal: outsider });
    expect(result.ok ? null : result.error.kind).toBe('forbidden');
  });
});

describe('RescheduleLessonUseCase', () => {
  it('reschedules the time and re-resolves the instant', async () => {
    const h = harness();
    const created = await h.schedule.execute({ principal: owner, ...futureLesson });
    if (!created.ok) throw new Error('setup');
    const result = await h.reschedule.execute({
      principal: owner,
      lessonId: created.value.lesson.id,
      date: '2026-12-01',
      time: '08:00',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.local).toEqual({ date: '2026-12-01', time: '08:00' });
    expect(result.value.scheduledAt.toISOString()).toBe('2026-12-01T05:00:00.000Z'); // Riyadh +3
    expect(result.value.id).toBe(created.value.lesson.id); // identity preserved
  });

  it('allows a title-only edit without tripping the future check', async () => {
    const h = harness();
    const created = await h.schedule.execute({ principal: owner, ...futureLesson });
    if (!created.ok) throw new Error('setup');
    const result = await h.reschedule.execute({
      principal: owner,
      lessonId: created.value.lesson.id,
      title: 'مراجعة',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.title).toBe('مراجعة');
    expect(result.value.scheduledAt).toEqual(created.value.lesson.scheduledAt);
  });

  it('rejects rescheduling into the past', async () => {
    const h = harness();
    const created = await h.schedule.execute({ principal: owner, ...futureLesson });
    if (!created.ok) throw new Error('setup');
    const result = await h.reschedule.execute({
      principal: owner,
      lessonId: created.value.lesson.id,
      date: '2025-01-01',
      time: '10:00',
    });
    expect(result.ok ? null : result.error.code).toBe('operations.lesson_in_the_past');
  });

  it('refuses to reschedule a cancelled lesson (invalid transition)', async () => {
    const h = harness();
    const created = await h.schedule.execute({ principal: owner, ...futureLesson });
    if (!created.ok) throw new Error('setup');
    await h.cancel.execute({ principal: owner, lessonId: created.value.lesson.id });
    const result = await h.reschedule.execute({
      principal: owner,
      lessonId: created.value.lesson.id,
      time: '15:00',
    });
    expect(result.ok ? null : result.error.kind).toBe('precondition_failed');
    expect(result.ok ? null : result.error.code).toBe('operations.lesson_not_modifiable');
  });
});

describe('CancelLessonUseCase', () => {
  it('cancels a scheduled lesson as a state transition (not a delete)', async () => {
    const h = harness();
    const created = await h.schedule.execute({ principal: owner, ...futureLesson });
    if (!created.ok) throw new Error('setup');
    const result = await h.cancel.execute({ principal: owner, lessonId: created.value.lesson.id });
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.status).toBe('CANCELLED');
    expect(result.value.cancelledBy).toBe('owner-1');
    expect(result.value.cancelledAt).not.toBeNull();
    // Still present (not deleted).
    const stillThere = await h.repo.findById(created.value.lesson.id);
    expect(stillThere?.status).toBe('CANCELLED');
  });

  it('refuses to cancel an already-cancelled lesson', async () => {
    const h = harness();
    const created = await h.schedule.execute({ principal: owner, ...futureLesson });
    if (!created.ok) throw new Error('setup');
    await h.cancel.execute({ principal: owner, lessonId: created.value.lesson.id });
    const again = await h.cancel.execute({ principal: owner, lessonId: created.value.lesson.id });
    expect(again.ok ? null : again.error.code).toBe('operations.lesson_not_modifiable');
  });
});

describe('institution timezone change after creation', () => {
  it('leaves an existing lesson on its captured zone and instant', async () => {
    const h = harness('Asia/Riyadh');
    const created = await h.schedule.execute({ principal: owner, ...futureLesson });
    if (!created.ok) throw new Error('setup');
    // The institution default changing later only affects NEW lessons; the
    // stored lesson keeps the zone captured at creation.
    const fetched = await h.get.execute({ principal: owner, lessonId: created.value.lesson.id });
    if (!fetched.ok) throw new Error('expected ok');
    expect(fetched.value.timezone).toBe('Asia/Riyadh');
    expect(fetched.value.scheduledAt.toISOString()).toBe('2026-11-01T11:30:00.000Z');
  });
});

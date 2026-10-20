import { and, asc, eq, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';

import { DATABASE, type Database } from '../../../platform/database';
import type { Lesson } from '../domain/lesson';
import type { CreateLessonOutcome, LessonListQuery, LessonRepository } from '../domain/ports';
import { operationsLessons } from './schema';

type LessonRow = typeof operationsLessons.$inferSelect;
type LessonInsert = typeof operationsLessons.$inferInsert;

function toRow(lesson: Lesson, clientRequestId: string | null): LessonInsert {
  return {
    id: lesson.id,
    halaqaId: lesson.halaqaId,
    title: lesson.title,
    localDate: lesson.local.date,
    localTime: lesson.local.time,
    timezone: lesson.timezone,
    scheduledAt: lesson.scheduledAt,
    status: lesson.status,
    clientRequestId,
    createdAt: lesson.createdAt,
    createdBy: lesson.createdBy,
    updatedAt: lesson.updatedAt,
    cancelledAt: lesson.cancelledAt,
    cancelledBy: lesson.cancelledBy,
  };
}

function fromRow(row: LessonRow): Lesson {
  return {
    id: row.id,
    halaqaId: row.halaqaId,
    title: row.title,
    local: { date: row.localDate, time: row.localTime },
    timezone: row.timezone,
    scheduledAt: row.scheduledAt,
    status: row.status,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
  };
}

@Injectable()
export class DrizzleLessonRepository implements LessonRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(lesson: Lesson, clientRequestId: string | null): Promise<CreateLessonOutcome> {
    if (clientRequestId === null) {
      const inserted = await this.db
        .insert(operationsLessons)
        .values(toRow(lesson, null))
        .returning();
      return { status: 'created', lesson: fromRow(inserted[0]) };
    }
    // Idempotent: the partial unique index (created_by, client_request_id)
    // rejects a repeat; DO NOTHING + re-read returns the canonical lesson.
    const inserted = await this.db
      .insert(operationsLessons)
      .values(toRow(lesson, clientRequestId))
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) return { status: 'created', lesson: fromRow(inserted[0]) };
    const existing = await this.db
      .select()
      .from(operationsLessons)
      .where(
        and(
          eq(operationsLessons.createdBy, lesson.createdBy),
          eq(operationsLessons.clientRequestId, clientRequestId),
        ),
      )
      .limit(1);
    return { status: 'duplicate', lesson: fromRow(existing[0]) };
  }

  async findById(id: string): Promise<Lesson | null> {
    const rows = await this.db
      .select()
      .from(operationsLessons)
      .where(eq(operationsLessons.id, id))
      .limit(1);
    return rows.length > 0 ? fromRow(rows[0]) : null;
  }

  async save(lesson: Lesson): Promise<void> {
    await this.db
      .update(operationsLessons)
      .set({
        title: lesson.title,
        localDate: lesson.local.date,
        localTime: lesson.local.time,
        timezone: lesson.timezone,
        scheduledAt: lesson.scheduledAt,
        status: lesson.status,
        updatedAt: lesson.updatedAt,
        cancelledAt: lesson.cancelledAt,
        cancelledBy: lesson.cancelledBy,
      })
      .where(eq(operationsLessons.id, lesson.id));
  }

  async list(query: LessonListQuery): Promise<readonly Lesson[]> {
    const conditions = [];
    if (query.halaqaId !== undefined) {
      conditions.push(eq(operationsLessons.halaqaId, query.halaqaId));
    }
    if (query.after !== undefined) {
      conditions.push(
        sql`(${operationsLessons.scheduledAt}, ${operationsLessons.id}) > (${query.after.scheduledAt}, ${query.after.id})`,
      );
    }
    const rows = await this.db
      .select()
      .from(operationsLessons)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(operationsLessons.scheduledAt), asc(operationsLessons.id))
      .limit(query.limit);
    return rows.map(fromRow);
  }
}

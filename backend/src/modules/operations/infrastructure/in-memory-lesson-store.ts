import { Injectable } from '@nestjs/common';

import type { Lesson } from '../domain/lesson';
import type { CreateLessonOutcome, LessonListQuery, LessonRepository } from '../domain/ports';

/**
 * In-memory lessons — used when no database is configured (demo/tests). It
 * holds the same invariants as the table: one lesson per id, idempotent create
 * per (creator, clientRequestId), and (scheduledAt, id)-ordered keyset paging.
 * Single-threaded JS is its lock.
 */
@Injectable()
export class InMemoryLessonStore implements LessonRepository {
  private readonly byId = new Map<string, Lesson>();
  private readonly byRequest = new Map<string, string>();

  private requestKey(createdBy: string, clientRequestId: string): string {
    return `${createdBy}\u0000${clientRequestId}`;
  }

  async create(lesson: Lesson, clientRequestId: string | null): Promise<CreateLessonOutcome> {
    if (clientRequestId !== null) {
      const key = this.requestKey(lesson.createdBy, clientRequestId);
      const existingId = this.byRequest.get(key);
      if (existingId !== undefined) {
        return { status: 'duplicate', lesson: this.byId.get(existingId)! };
      }
      this.byId.set(lesson.id, lesson);
      this.byRequest.set(key, lesson.id);
      return { status: 'created', lesson };
    }
    this.byId.set(lesson.id, lesson);
    return { status: 'created', lesson };
  }

  async findById(id: string): Promise<Lesson | null> {
    return this.byId.get(id) ?? null;
  }

  async save(lesson: Lesson): Promise<void> {
    this.byId.set(lesson.id, lesson);
  }

  async list(query: LessonListQuery): Promise<readonly Lesson[]> {
    let rows = [...this.byId.values()];
    if (query.halaqaId !== undefined) {
      rows = rows.filter((lesson) => lesson.halaqaId === query.halaqaId);
    }
    rows.sort(
      (a, b) =>
        a.scheduledAt.getTime() - b.scheduledAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    if (query.after !== undefined) {
      const afterMs = query.after.scheduledAt.getTime();
      const afterId = query.after.id;
      rows = rows.filter((lesson) => {
        const ms = lesson.scheduledAt.getTime();
        return ms > afterMs || (ms === afterMs && lesson.id > afterId);
      });
    }
    return rows.slice(0, query.limit);
  }
}

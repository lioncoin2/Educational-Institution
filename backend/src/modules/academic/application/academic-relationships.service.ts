import { Inject, Injectable } from '@nestjs/common';

import {
  ACADEMIC_RELATIONSHIPS_MAX_PAGE,
  type AcademicRelationships,
} from '../contracts/relationships';
import {
  ACADEMIC_READ_MODEL,
  ACADEMIC_REPOSITORY,
  type AcademicReadModel,
  type AcademicRepository,
} from '../domain/ports';
import { decodeCursor, paged } from './cursors';

/**
 * `ACADEMIC_RELATIONSHIPS` — who is in a halaqa now, for other modules. The
 * same records academic's own scope checks read; nothing is cached.
 */
@Injectable()
export class AcademicRelationshipsService implements AcademicRelationships {
  constructor(
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel,
  ) {}

  isEnrolled(studentUserId: string, halaqaId: string): Promise<boolean> {
    return this.repository.isEnrolled(studentUserId, halaqaId);
  }

  isTeaching(teacherUserId: string, halaqaId: string): Promise<boolean> {
    return this.repository.isTeaching(teacherUserId, halaqaId);
  }

  async activeStudentIds(
    halaqaId: string,
    page: { readonly cursor?: string; readonly limit: number },
  ): Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }> {
    const after = decodeCursor(page.cursor);
    if (!after.ok) throw new RangeError(after.error.message);
    const limit = Math.max(1, Math.min(Math.trunc(page.limit), ACADEMIC_RELATIONSHIPS_MAX_PAGE));
    const rows = await this.readModel.roster(halaqaId, 'ACTIVE', {
      after: after.value,
      limit: limit + 1,
    });
    const result = paged(rows, limit, (row) => ({ at: row.enrolledAt, id: row.id }));
    return {
      userIds: result.items.map((row) => row.studentUserId),
      nextCursor: result.nextCursor,
    };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { AssignmentStatus, EnrollmentStatus } from '../contracts/vocabulary';
import type { Enrollment } from '../domain/enrollment';
import type {
  AcademicReadModel,
  Catalogue,
  Keyset,
  PlacedAssignment,
  PlacedEnrollment,
} from '../domain/ports';
import type { Halaqa, Program, Section } from '../domain/structure';
import type { TeacherAssignment } from '../domain/teacher-assignment';
import { toAssignment, toEnrollment, toHalaqa, toProgram, toSection } from './row-mapping';
import {
  academicEnrollments,
  academicHalaqat,
  academicPrograms,
  academicSections,
  academicTeacherAssignments,
} from './schema';

/** `(instant, id) > (…)` or `< (…)` — the keyset step, as one row comparison the index serves. */
function beyond(instant: unknown, id: unknown, key: Keyset, direction: '>' | '<'): SQL {
  return sql`(${instant}, ${id}) ${sql.raw(direction)} (${key.at.toISOString()}::timestamptz, ${key.id})`;
}

/**
 * Academic's lists over Postgres — one query each, joins instead of lookups
 * per row. Which index serves which list is stated on the schema; the
 * integration suite asserts the important plans with EXPLAIN.
 */
@Injectable()
export class DrizzleAcademicReadModel implements AcademicReadModel {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async catalogue(): Promise<Catalogue> {
    const sections = await this.db
      .select()
      .from(academicSections)
      .orderBy(asc(academicSections.sortOrder), asc(academicSections.code));
    const programs = await this.db
      .select()
      .from(academicPrograms)
      .orderBy(asc(academicPrograms.sortOrder), asc(academicPrograms.code));
    return {
      sections: sections.map(toSection),
      programs: programs.map(toProgram),
      activeHalaqaCounts: await this.counts(programs.map((p) => p.id)),
    };
  }

  async sectionCatalogue(sectionId: string): Promise<Catalogue | null> {
    const [section] = await this.db
      .select()
      .from(academicSections)
      .where(eq(academicSections.id, sectionId))
      .limit(1);
    if (section === undefined) return null;
    const programs = await this.db
      .select()
      .from(academicPrograms)
      .where(eq(academicPrograms.sectionId, sectionId))
      .orderBy(asc(academicPrograms.sortOrder), asc(academicPrograms.code));
    return {
      sections: [toSection(section)],
      programs: programs.map(toProgram),
      activeHalaqaCounts: await this.counts(programs.map((p) => p.id)),
    };
  }

  async halaqatOf(programId: string): Promise<readonly Halaqa[]> {
    const rows = await this.db
      .select()
      .from(academicHalaqat)
      .where(eq(academicHalaqat.programId, programId))
      .orderBy(asc(academicHalaqat.sortOrder), asc(academicHalaqat.code));
    return rows.map(toHalaqa);
  }

  async roster(
    halaqaId: string,
    status: EnrollmentStatus,
    page: { readonly after?: Keyset; readonly limit: number },
  ): Promise<readonly Enrollment[]> {
    const rows = await this.db
      .select()
      .from(academicEnrollments)
      .where(
        and(
          eq(academicEnrollments.halaqaId, halaqaId),
          eq(academicEnrollments.status, status),
          page.after === undefined
            ? undefined
            : beyond(academicEnrollments.enrolledAt, academicEnrollments.id, page.after, '>'),
        ),
      )
      .orderBy(asc(academicEnrollments.enrolledAt), asc(academicEnrollments.id))
      .limit(page.limit);
    return rows.map(toEnrollment);
  }

  async teachersOf(
    halaqaId: string,
    status: AssignmentStatus,
    page: { readonly after?: Keyset; readonly limit: number },
  ): Promise<readonly TeacherAssignment[]> {
    const rows = await this.db
      .select()
      .from(academicTeacherAssignments)
      .where(
        and(
          eq(academicTeacherAssignments.halaqaId, halaqaId),
          eq(academicTeacherAssignments.status, status),
          page.after === undefined
            ? undefined
            : beyond(
                academicTeacherAssignments.startedAt,
                academicTeacherAssignments.id,
                page.after,
                '>',
              ),
        ),
      )
      .orderBy(asc(academicTeacherAssignments.startedAt), asc(academicTeacherAssignments.id))
      .limit(page.limit);
    return rows.map(toAssignment);
  }

  async activeTeachersOf(halaqaIds: readonly string[]): Promise<readonly TeacherAssignment[]> {
    if (halaqaIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(academicTeacherAssignments)
      .where(
        and(
          inArray(academicTeacherAssignments.halaqaId, [...halaqaIds]),
          eq(academicTeacherAssignments.status, 'ACTIVE'),
        ),
      )
      .orderBy(asc(academicTeacherAssignments.startedAt), asc(academicTeacherAssignments.id));
    return rows.map(toAssignment);
  }

  async enrollmentsOf(
    studentUserId: string,
    page: { readonly before?: Keyset; readonly limit: number },
  ): Promise<readonly PlacedEnrollment[]> {
    const rows = await this.placedEnrollments()
      .where(
        and(
          eq(academicEnrollments.studentUserId, studentUserId),
          page.before === undefined
            ? undefined
            : beyond(academicEnrollments.enrolledAt, academicEnrollments.id, page.before, '<'),
        ),
      )
      .orderBy(desc(academicEnrollments.enrolledAt), desc(academicEnrollments.id))
      .limit(page.limit);
    return rows.map((row) => ({
      enrollment: toEnrollment(row.enrollment),
      ...this.place(row),
    }));
  }

  async activeEnrollmentsOf(
    studentUserId: string,
    limit: number,
  ): Promise<readonly PlacedEnrollment[]> {
    const rows = await this.placedEnrollments()
      .where(
        and(
          eq(academicEnrollments.studentUserId, studentUserId),
          eq(academicEnrollments.status, 'ACTIVE'),
        ),
      )
      .orderBy(asc(academicEnrollments.enrolledAt), asc(academicEnrollments.id))
      .limit(limit);
    return rows.map((row) => ({
      enrollment: toEnrollment(row.enrollment),
      ...this.place(row),
    }));
  }

  async assignmentsOf(
    teacherUserId: string,
    page: { readonly before?: Keyset; readonly limit: number },
  ): Promise<readonly PlacedAssignment[]> {
    const rows = await this.placedAssignments()
      .where(
        and(
          eq(academicTeacherAssignments.teacherUserId, teacherUserId),
          page.before === undefined
            ? undefined
            : beyond(
                academicTeacherAssignments.startedAt,
                academicTeacherAssignments.id,
                page.before,
                '<',
              ),
        ),
      )
      .orderBy(desc(academicTeacherAssignments.startedAt), desc(academicTeacherAssignments.id))
      .limit(page.limit);
    return rows.map((row) => ({
      assignment: toAssignment(row.assignment),
      ...this.place(row),
    }));
  }

  async activeAssignmentsOf(
    teacherUserId: string,
    limit: number,
  ): Promise<readonly PlacedAssignment[]> {
    const rows = await this.placedAssignments()
      .where(
        and(
          eq(academicTeacherAssignments.teacherUserId, teacherUserId),
          eq(academicTeacherAssignments.status, 'ACTIVE'),
        ),
      )
      .orderBy(asc(academicTeacherAssignments.startedAt), asc(academicTeacherAssignments.id))
      .limit(limit);
    return rows.map((row) => ({
      assignment: toAssignment(row.assignment),
      ...this.place(row),
    }));
  }

  private placedEnrollments() {
    return this.db
      .select({
        enrollment: academicEnrollments,
        halaqa: academicHalaqat,
        program: academicPrograms,
        section: academicSections,
      })
      .from(academicEnrollments)
      .innerJoin(academicHalaqat, eq(academicHalaqat.id, academicEnrollments.halaqaId))
      .innerJoin(academicPrograms, eq(academicPrograms.id, academicHalaqat.programId))
      .innerJoin(academicSections, eq(academicSections.id, academicPrograms.sectionId))
      .$dynamic();
  }

  private placedAssignments() {
    return this.db
      .select({
        assignment: academicTeacherAssignments,
        halaqa: academicHalaqat,
        program: academicPrograms,
        section: academicSections,
      })
      .from(academicTeacherAssignments)
      .innerJoin(academicHalaqat, eq(academicHalaqat.id, academicTeacherAssignments.halaqaId))
      .innerJoin(academicPrograms, eq(academicPrograms.id, academicHalaqat.programId))
      .innerJoin(academicSections, eq(academicSections.id, academicPrograms.sectionId))
      .$dynamic();
  }

  private place(row: {
    readonly halaqa: typeof academicHalaqat.$inferSelect;
    readonly program: typeof academicPrograms.$inferSelect;
    readonly section: typeof academicSections.$inferSelect;
  }): { halaqa: Halaqa; program: Program; section: Section } {
    return {
      halaqa: toHalaqa(row.halaqa),
      program: toProgram(row.program),
      section: toSection(row.section),
    };
  }

  /** ACTIVE halaqat per program, for the programs given — one grouped query. */
  private async counts(programIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (programIds.length === 0) return new Map();
    const rows = await this.db
      .select({ programId: academicHalaqat.programId, count: sql<number>`count(*)::int` })
      .from(academicHalaqat)
      .where(
        and(
          inArray(academicHalaqat.programId, [...programIds]),
          eq(academicHalaqat.status, 'ACTIVE'),
        ),
      )
      .groupBy(academicHalaqat.programId);
    return new Map(rows.map((row) => [row.programId, row.count]));
  }
}

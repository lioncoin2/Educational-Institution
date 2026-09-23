import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { EnrollmentOutcome, StructureStatus } from '../contracts/vocabulary';
import type { Enrollment } from '../domain/enrollment';
import type {
  AcademicRepository,
  AssignOutcome,
  CreateOutcome,
  EndOutcome,
  EnrollOutcome,
  Placement,
  StatusOutcome,
} from '../domain/ports';
import { openForEnrollment, type Halaqa, type Program, type Section } from '../domain/structure';
import type { TeacherAssignment } from '../domain/teacher-assignment';
import {
  assignmentRow,
  enrollmentRow,
  halaqaRow,
  programRow,
  sectionRow,
  toAssignment,
  toEnrollment,
  toHalaqa,
  toProgram,
  toSection,
} from './row-mapping';
import {
  academicEnrollments,
  academicHalaqat,
  academicPrograms,
  academicSections,
  academicTeacherAssignments,
} from './schema';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Transaction;

/** `greatest(column, at)` — a stored instant never moves backwards on a lagging clock. */
function notBefore(column: unknown, at: Date) {
  return sql`greatest(${column}, ${at.toISOString()}::timestamptz)`;
}

/**
 * Serializes the creations that one cap counts, without locking any row a
 * reader or an enrollment needs: a transaction-scoped advisory lock per
 * parent ("the programs of section S").
 */
async function capLock(tx: Transaction, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * Academic in Postgres. Every invariant that concurrency could break is
 * decided by the database here:
 *
 *   one ACTIVE enrollment      INSERT … ON CONFLICT on the partial unique index
 *   one ACTIVE assignment      the same, on its own partial unique index
 *   open for enrollment        the halaqa, program and section rows are locked
 *                              FOR SHARE while the enrollment is written; a
 *                              deactivation (an UPDATE, or FOR UPDATE) waits for
 *                              it — or it waits, and then sees the new status
 *   no ACTIVE enrollment in    deactivating a halaqa locks it FOR UPDATE, then
 *   an INACTIVE halaqa         looks for active enrollments — any enrollment in
 *                              flight has committed or not started by then
 *   caps                       an advisory lock per parent while counting
 *   unique codes               ON CONFLICT (code) DO NOTHING
 */
@Injectable()
export class DrizzleAcademicRepository implements AcademicRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  // ── Structure ──────────────────────────────────────────────────────────

  async findSection(id: string): Promise<Section | null> {
    const [row] = await this.db
      .select()
      .from(academicSections)
      .where(eq(academicSections.id, id))
      .limit(1);
    return row === undefined ? null : toSection(row);
  }

  async findProgram(id: string): Promise<Program | null> {
    const [row] = await this.db
      .select()
      .from(academicPrograms)
      .where(eq(academicPrograms.id, id))
      .limit(1);
    return row === undefined ? null : toProgram(row);
  }

  async findHalaqa(id: string): Promise<Halaqa | null> {
    const [row] = await this.db
      .select()
      .from(academicHalaqat)
      .where(eq(academicHalaqat.id, id))
      .limit(1);
    return row === undefined ? null : toHalaqa(row);
  }

  async placement(halaqaId: string): Promise<Placement | null> {
    return this.placed(this.db, halaqaId, false);
  }

  async sectionByCode(code: string): Promise<Section | null> {
    const [row] = await this.db
      .select()
      .from(academicSections)
      .where(eq(academicSections.code, code))
      .limit(1);
    return row === undefined ? null : toSection(row);
  }

  async programByCode(code: string): Promise<Program | null> {
    const [row] = await this.db
      .select()
      .from(academicPrograms)
      .where(eq(academicPrograms.code, code))
      .limit(1);
    return row === undefined ? null : toProgram(row);
  }

  async halaqaByCode(code: string): Promise<Halaqa | null> {
    const [row] = await this.db
      .select()
      .from(academicHalaqat)
      .where(eq(academicHalaqat.code, code))
      .limit(1);
    return row === undefined ? null : toHalaqa(row);
  }

  async createSection(section: Section, limit: number): Promise<CreateOutcome> {
    return this.db.transaction(async (tx) => {
      await capLock(tx, 'academic.sections');
      const [counted] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(academicSections);
      if ((counted?.count ?? 0) >= limit) return { kind: 'limit_reached', limit };
      const inserted = await tx
        .insert(academicSections)
        .values(sectionRow(section))
        .onConflictDoNothing({ target: academicSections.code })
        .returning({ id: academicSections.id });
      return inserted.length === 0 ? { kind: 'code_taken' } : { kind: 'created' };
    });
  }

  async createProgram(program: Program, limit: number): Promise<CreateOutcome> {
    return this.db.transaction(async (tx) => {
      await capLock(tx, `academic.programs:${program.sectionId}`);
      const [parent] = await tx
        .select({ id: academicSections.id })
        .from(academicSections)
        .where(eq(academicSections.id, program.sectionId));
      if (parent === undefined) return { kind: 'parent_not_found' };
      const [counted] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(academicPrograms)
        .where(eq(academicPrograms.sectionId, program.sectionId));
      if ((counted?.count ?? 0) >= limit) return { kind: 'limit_reached', limit };
      const inserted = await tx
        .insert(academicPrograms)
        .values(programRow(program))
        .onConflictDoNothing({ target: academicPrograms.code })
        .returning({ id: academicPrograms.id });
      return inserted.length === 0 ? { kind: 'code_taken' } : { kind: 'created' };
    });
  }

  async createHalaqa(halaqa: Halaqa, limit: number): Promise<CreateOutcome> {
    return this.db.transaction(async (tx) => {
      await capLock(tx, `academic.halaqat:${halaqa.programId}`);
      const [parent] = await tx
        .select({ id: academicPrograms.id })
        .from(academicPrograms)
        .where(eq(academicPrograms.id, halaqa.programId));
      if (parent === undefined) return { kind: 'parent_not_found' };
      const [counted] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(academicHalaqat)
        .where(eq(academicHalaqat.programId, halaqa.programId));
      if ((counted?.count ?? 0) >= limit) return { kind: 'limit_reached', limit };
      const inserted = await tx
        .insert(academicHalaqat)
        .values(halaqaRow(halaqa))
        .onConflictDoNothing({ target: academicHalaqat.code })
        .returning({ id: academicHalaqat.id });
      return inserted.length === 0 ? { kind: 'code_taken' } : { kind: 'created' };
    });
  }

  async saveSection(section: Section): Promise<void> {
    await this.db
      .update(academicSections)
      .set({
        name: section.name,
        sortOrder: section.order,
        description: section.description,
        updatedAt: notBefore(academicSections.updatedAt, section.updatedAt),
      })
      .where(eq(academicSections.id, section.id));
  }

  async saveProgram(program: Program): Promise<void> {
    await this.db
      .update(academicPrograms)
      .set({
        name: program.name,
        sortOrder: program.order,
        description: program.description,
        updatedAt: notBefore(academicPrograms.updatedAt, program.updatedAt),
      })
      .where(eq(academicPrograms.id, program.id));
  }

  async saveHalaqa(halaqa: Halaqa): Promise<void> {
    await this.db
      .update(academicHalaqat)
      .set({
        name: halaqa.name,
        sortOrder: halaqa.order,
        updatedAt: notBefore(academicHalaqat.updatedAt, halaqa.updatedAt),
      })
      .where(eq(academicHalaqat.id, halaqa.id));
  }

  async setSectionStatus(
    id: string,
    status: StructureStatus,
    at: Date,
  ): Promise<StatusOutcome<Section>> {
    const [row] = await this.db
      .update(academicSections)
      .set({ status, updatedAt: notBefore(academicSections.updatedAt, at) })
      .where(and(eq(academicSections.id, id), ne(academicSections.status, status)))
      .returning();
    if (row !== undefined) return { kind: 'changed', entity: toSection(row) };
    const current = await this.findSection(id);
    return current === null ? { kind: 'not_found' } : { kind: 'unchanged', entity: current };
  }

  async setProgramStatus(
    id: string,
    status: StructureStatus,
    at: Date,
  ): Promise<StatusOutcome<Program>> {
    const [row] = await this.db
      .update(academicPrograms)
      .set({ status, updatedAt: notBefore(academicPrograms.updatedAt, at) })
      .where(and(eq(academicPrograms.id, id), ne(academicPrograms.status, status)))
      .returning();
    if (row !== undefined) return { kind: 'changed', entity: toProgram(row) };
    const current = await this.findProgram(id);
    return current === null ? { kind: 'not_found' } : { kind: 'unchanged', entity: current };
  }

  async activateHalaqa(id: string, at: Date): Promise<StatusOutcome<Halaqa>> {
    const [row] = await this.db
      .update(academicHalaqat)
      .set({ status: 'ACTIVE', updatedAt: notBefore(academicHalaqat.updatedAt, at) })
      .where(and(eq(academicHalaqat.id, id), ne(academicHalaqat.status, 'ACTIVE')))
      .returning();
    if (row !== undefined) return { kind: 'changed', entity: toHalaqa(row) };
    const current = await this.findHalaqa(id);
    return current === null ? { kind: 'not_found' } : { kind: 'unchanged', entity: current };
  }

  async deactivateHalaqa(
    id: string,
    at: Date,
  ): Promise<StatusOutcome<Halaqa> | { readonly kind: 'has_active_enrollments' }> {
    return this.db.transaction(async (tx) => {
      // FOR UPDATE waits for every enrollment holding the row FOR SHARE: by
      // the time it returns, an enrollment in flight has committed (and is
      // counted below) or has not begun (and will see INACTIVE).
      const [locked] = await tx
        .select()
        .from(academicHalaqat)
        .where(eq(academicHalaqat.id, id))
        .for('update');
      if (locked === undefined) return { kind: 'not_found' };
      if (locked.status === 'INACTIVE') return { kind: 'unchanged', entity: toHalaqa(locked) };
      const [busy] = await tx
        .select({ id: academicEnrollments.id })
        .from(academicEnrollments)
        .where(and(eq(academicEnrollments.halaqaId, id), eq(academicEnrollments.status, 'ACTIVE')))
        .limit(1);
      if (busy !== undefined) return { kind: 'has_active_enrollments' };
      const [row] = await tx
        .update(academicHalaqat)
        .set({ status: 'INACTIVE', updatedAt: notBefore(academicHalaqat.updatedAt, at) })
        .where(eq(academicHalaqat.id, id))
        .returning();
      if (row === undefined) throw new Error(`halaqa ${id} vanished while locked`);
      return { kind: 'changed', entity: toHalaqa(row) };
    });
  }

  // ── Enrollment ─────────────────────────────────────────────────────────

  async enroll(enrollment: Enrollment): Promise<EnrollOutcome> {
    return this.db.transaction(async (tx) => {
      const placement = await this.placed(tx, enrollment.halaqaId, true);
      if (placement === null) return { kind: 'halaqa_not_found' };
      const open = openForEnrollment(placement);
      if (!open.ok) return { kind: 'closed', failure: open.error };

      // Twice at most: the second covers the rare case where the ACTIVE row
      // we collided with was ended between our insert and our read.
      for (let attempt = 0; attempt < 2; attempt++) {
        const [created] = await tx
          .insert(academicEnrollments)
          .values(enrollmentRow(enrollment))
          .onConflictDoNothing({
            target: [academicEnrollments.studentUserId, academicEnrollments.halaqaId],
            where: sql`status = 'ACTIVE'`,
          })
          .returning();
        if (created !== undefined) {
          return { kind: 'created', enrollment: toEnrollment(created), placement };
        }
        const [existing] = await tx
          .select()
          .from(academicEnrollments)
          .where(
            and(
              eq(academicEnrollments.studentUserId, enrollment.studentUserId),
              eq(academicEnrollments.halaqaId, enrollment.halaqaId),
              eq(academicEnrollments.status, 'ACTIVE'),
            ),
          )
          .limit(1);
        if (existing !== undefined) {
          return { kind: 'existing', enrollment: toEnrollment(existing), placement };
        }
      }
      throw new Error('enrollment neither inserted nor found');
    });
  }

  async findEnrollment(id: string): Promise<Enrollment | null> {
    const [row] = await this.db
      .select()
      .from(academicEnrollments)
      .where(eq(academicEnrollments.id, id))
      .limit(1);
    return row === undefined ? null : toEnrollment(row);
  }

  async endEnrollment(
    id: string,
    outcome: EnrollmentOutcome,
    by: string | null,
    at: Date,
  ): Promise<EndOutcome<Enrollment>> {
    const [row] = await this.db
      .update(academicEnrollments)
      .set({
        status: outcome,
        endedAt: notBefore(academicEnrollments.enrolledAt, at),
        endedBy: by,
        updatedAt: notBefore(academicEnrollments.updatedAt, at),
      })
      .where(and(eq(academicEnrollments.id, id), eq(academicEnrollments.status, 'ACTIVE')))
      .returning();
    if (row !== undefined) return { kind: 'ended', entity: toEnrollment(row) };
    const current = await this.findEnrollment(id);
    return current === null ? { kind: 'not_found' } : { kind: 'not_active', entity: current };
  }

  // ── Teaching ───────────────────────────────────────────────────────────

  async assignTeacher(assignment: TeacherAssignment): Promise<AssignOutcome> {
    return this.db.transaction(async (tx) => {
      const [halaqa] = await tx
        .select({ id: academicHalaqat.id })
        .from(academicHalaqat)
        .where(eq(academicHalaqat.id, assignment.halaqaId));
      if (halaqa === undefined) return { kind: 'halaqa_not_found' };
      for (let attempt = 0; attempt < 2; attempt++) {
        const [created] = await tx
          .insert(academicTeacherAssignments)
          .values(assignmentRow(assignment))
          .onConflictDoNothing({
            target: [academicTeacherAssignments.halaqaId, academicTeacherAssignments.teacherUserId],
            where: sql`status = 'ACTIVE'`,
          })
          .returning();
        if (created !== undefined) return { kind: 'created', assignment: toAssignment(created) };
        const [existing] = await tx
          .select()
          .from(academicTeacherAssignments)
          .where(
            and(
              eq(academicTeacherAssignments.halaqaId, assignment.halaqaId),
              eq(academicTeacherAssignments.teacherUserId, assignment.teacherUserId),
              eq(academicTeacherAssignments.status, 'ACTIVE'),
            ),
          )
          .limit(1);
        if (existing !== undefined) return { kind: 'existing', assignment: toAssignment(existing) };
      }
      throw new Error('assignment neither inserted nor found');
    });
  }

  async findAssignment(id: string): Promise<TeacherAssignment | null> {
    const [row] = await this.db
      .select()
      .from(academicTeacherAssignments)
      .where(eq(academicTeacherAssignments.id, id))
      .limit(1);
    return row === undefined ? null : toAssignment(row);
  }

  async endAssignment(
    id: string,
    by: string | null,
    at: Date,
  ): Promise<EndOutcome<TeacherAssignment>> {
    const [row] = await this.db
      .update(academicTeacherAssignments)
      .set({
        status: 'ENDED',
        endedAt: notBefore(academicTeacherAssignments.startedAt, at),
        endedBy: by,
      })
      .where(
        and(eq(academicTeacherAssignments.id, id), eq(academicTeacherAssignments.status, 'ACTIVE')),
      )
      .returning();
    if (row !== undefined) return { kind: 'ended', entity: toAssignment(row) };
    const current = await this.findAssignment(id);
    return current === null ? { kind: 'not_found' } : { kind: 'not_active', entity: current };
  }

  async isEnrolled(studentUserId: string, halaqaId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: academicEnrollments.id })
      .from(academicEnrollments)
      .where(
        and(
          eq(academicEnrollments.studentUserId, studentUserId),
          eq(academicEnrollments.halaqaId, halaqaId),
          eq(academicEnrollments.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async isTeaching(teacherUserId: string, halaqaId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: academicTeacherAssignments.id })
      .from(academicTeacherAssignments)
      .where(
        and(
          eq(academicTeacherAssignments.halaqaId, halaqaId),
          eq(academicTeacherAssignments.teacherUserId, teacherUserId),
          eq(academicTeacherAssignments.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** The halaqa, its program and section — locked FOR SHARE when `lock` is set. */
  private async placed(
    executor: Executor,
    halaqaId: string,
    lock: boolean,
  ): Promise<Placement | null> {
    const query = executor
      .select({ halaqa: academicHalaqat, program: academicPrograms, section: academicSections })
      .from(academicHalaqat)
      .innerJoin(academicPrograms, eq(academicPrograms.id, academicHalaqat.programId))
      .innerJoin(academicSections, eq(academicSections.id, academicPrograms.sectionId))
      .where(eq(academicHalaqat.id, halaqaId));
    const [row] = lock ? await query.for('share') : await query.limit(1);
    if (row === undefined) return null;
    return {
      halaqa: toHalaqa(row.halaqa),
      program: toProgram(row.program),
      section: toSection(row.section),
    };
  }
}

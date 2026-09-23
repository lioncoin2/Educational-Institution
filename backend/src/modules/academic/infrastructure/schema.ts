import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import type {
  AssignmentStatus,
  EnrollmentStatus,
  SectionKind,
  StructureStatus,
  TeachingRole,
} from '../contracts/vocabulary';

/**
 * Academic's tables. Academic owns them; no other module reads or writes them
 * (dependency-cruiser and test/architecture/academic-boundaries.spec.ts).
 *
 * Account ids (`student_user_id`, `teacher_user_id`, `*_by`) are NOT foreign
 * keys: accounts belong to identity, and no module holds a constraint on
 * another's tables — suspending or disabling an account leaves its academic
 * history exactly as it was. Inside academic the keys are real, and RESTRICT:
 * nothing that history refers to can be deleted underneath it.
 *
 * The guarantees the database makes, by name:
 *
 *   academic_*_code_unique                   one entity per code
 *   academic_enrollments_active_unique       one ACTIVE enrollment per student and halaqa
 *   academic_teacher_assignments_active_unique   one ACTIVE assignment per teacher and halaqa
 *   academic_enrollments_ended_consistent    ACTIVE exactly when not ended
 *
 * The code, name and description CHECKs repeat the domain's rules (text.ts),
 * so a row written by any path is held to them.
 */
const CODE_SQL = "'^[a-z0-9]+(-[a-z0-9]+)*$'";

export const academicSections = pgTable(
  'academic_sections',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<SectionKind>().notNull(),
    sortOrder: integer('sort_order').notNull(),
    description: text('description'),
    status: text('status').$type<StructureStatus>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // The whole table is the catalogue's first query, bounded by
    // AcademicLimits.maxSections: no index beyond the key and the code.
    unique('academic_sections_code_unique').on(table.code),
    check(
      'academic_sections_code_shape',
      sql`${table.code} ~ ${sql.raw(CODE_SQL)} and char_length(${table.code}) between 2 and 64`,
    ),
    check('academic_sections_name_length', sql`char_length(${table.name}) between 1 and 120`),
    check(
      'academic_sections_description_length',
      sql`${table.description} is null or char_length(${table.description}) between 1 and 2000`,
    ),
    check(
      'academic_sections_kind_valid',
      sql`${table.kind} in ('PROGRESSIVE', 'SPECIAL', 'ACCOMPANYING')`,
    ),
    check('academic_sections_status_valid', sql`${table.status} in ('ACTIVE', 'INACTIVE')`),
    check('academic_sections_order_range', sql`${table.sortOrder} between 1 and 10000`),
    check('academic_sections_updated_after_created', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const academicPrograms = pgTable(
  'academic_programs',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    sectionId: text('section_id')
      .notNull()
      .references(() => academicSections.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull(),
    description: text('description'),
    status: text('status').$type<StructureStatus>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('academic_programs_code_unique').on(table.code),
    // A section's programs, in order — the section page and the cap's count.
    index('academic_programs_section_idx').on(table.sectionId, table.sortOrder, table.code),
    check(
      'academic_programs_code_shape',
      sql`${table.code} ~ ${sql.raw(CODE_SQL)} and char_length(${table.code}) between 2 and 64`,
    ),
    check('academic_programs_name_length', sql`char_length(${table.name}) between 1 and 120`),
    check(
      'academic_programs_description_length',
      sql`${table.description} is null or char_length(${table.description}) between 1 and 2000`,
    ),
    check('academic_programs_status_valid', sql`${table.status} in ('ACTIVE', 'INACTIVE')`),
    check('academic_programs_order_range', sql`${table.sortOrder} between 1 and 10000`),
    check('academic_programs_updated_after_created', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const academicHalaqat = pgTable(
  'academic_halaqat',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    programId: text('program_id')
      .notNull()
      .references(() => academicPrograms.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull(),
    status: text('status').$type<StructureStatus>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('academic_halaqat_code_unique').on(table.code),
    // A program's halaqat, in order — the program page and the cap's count.
    index('academic_halaqat_program_idx').on(table.programId, table.sortOrder, table.code),
    check(
      'academic_halaqat_code_shape',
      sql`${table.code} ~ ${sql.raw(CODE_SQL)} and char_length(${table.code}) between 2 and 64`,
    ),
    check('academic_halaqat_name_length', sql`char_length(${table.name}) between 1 and 120`),
    check('academic_halaqat_status_valid', sql`${table.status} in ('ACTIVE', 'INACTIVE')`),
    check('academic_halaqat_order_range', sql`${table.sortOrder} between 1 and 10000`),
    check('academic_halaqat_updated_after_created', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const academicTeacherAssignments = pgTable(
  'academic_teacher_assignments',
  {
    id: text('id').primaryKey(),
    halaqaId: text('halaqa_id')
      .notNull()
      .references(() => academicHalaqat.id, { onDelete: 'restrict' }),
    teacherUserId: text('teacher_user_id').notNull(),
    role: text('role').$type<TeachingRole>().notNull(),
    status: text('status').$type<AssignmentStatus>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    assignedBy: text('assigned_by'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: text('ended_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // One ACTIVE assignment per teacher and halaqa; ended ones are history
    // and may repeat. Also answers "does X teach H now?".
    uniqueIndex('academic_teacher_assignments_active_unique')
      .on(table.halaqaId, table.teacherUserId)
      .where(sql`${table.status} = 'ACTIVE'`),
    // A halaqa's teachers by status, oldest first — keyset pages.
    index('academic_teacher_assignments_halaqa_idx').on(
      table.halaqaId,
      table.status,
      table.startedAt,
      table.id,
    ),
    // A teacher's assignments, newest first — keyset pages and "what do I teach now".
    index('academic_teacher_assignments_teacher_idx').on(
      table.teacherUserId,
      table.startedAt,
      table.id,
    ),
    check(
      'academic_teacher_assignments_role_valid',
      sql`${table.role} in ('TEACHER', 'ASSISTANT_TEACHER')`,
    ),
    check('academic_teacher_assignments_status_valid', sql`${table.status} in ('ACTIVE', 'ENDED')`),
    check(
      'academic_teacher_assignments_ended_consistent',
      sql`(${table.status} = 'ACTIVE') = (${table.endedAt} is null)`,
    ),
    check(
      'academic_teacher_assignments_ended_after_started',
      sql`${table.endedAt} is null or ${table.endedAt} >= ${table.startedAt}`,
    ),
  ],
);

export const academicEnrollments = pgTable(
  'academic_enrollments',
  {
    id: text('id').primaryKey(),
    studentUserId: text('student_user_id').notNull(),
    halaqaId: text('halaqa_id')
      .notNull()
      .references(() => academicHalaqat.id, { onDelete: 'restrict' }),
    status: text('status').$type<EnrollmentStatus>().notNull(),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull(),
    enrolledBy: text('enrolled_by'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: text('ended_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // One ACTIVE enrollment per student and halaqa — the arbiter of
    // concurrent enrollments. Also a student's current enrollments.
    uniqueIndex('academic_enrollments_active_unique')
      .on(table.studentUserId, table.halaqaId)
      .where(sql`${table.status} = 'ACTIVE'`),
    // A halaqa's roster by status, in enrollment order — keyset pages, and
    // "does this halaqa still have active students?".
    index('academic_enrollments_halaqa_idx').on(
      table.halaqaId,
      table.status,
      table.enrolledAt,
      table.id,
    ),
    // A student's history, newest first — keyset pages.
    index('academic_enrollments_student_idx').on(table.studentUserId, table.enrolledAt, table.id),
    check(
      'academic_enrollments_status_valid',
      sql`${table.status} in ('ACTIVE', 'COMPLETED', 'WITHDRAWN')`,
    ),
    check(
      'academic_enrollments_ended_consistent',
      sql`(${table.status} = 'ACTIVE') = (${table.endedAt} is null)`,
    ),
    check(
      'academic_enrollments_ended_after_enrolled',
      sql`${table.endedAt} is null or ${table.endedAt} >= ${table.enrolledAt}`,
    ),
    check(
      'academic_enrollments_updated_after_created',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

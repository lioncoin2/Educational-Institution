import { Injectable } from '@nestjs/common';

import type {
  AssignmentStatus,
  EnrollmentOutcome,
  EnrollmentStatus,
  StructureStatus,
} from '../contracts/vocabulary';
import { ended, type Enrollment } from '../domain/enrollment';
import type {
  AcademicReadModel,
  AcademicRepository,
  AssignOutcome,
  Catalogue,
  CreateOutcome,
  EndOutcome,
  EnrollOutcome,
  Keyset,
  PlacedAssignment,
  PlacedEnrollment,
  Placement,
  StatusOutcome,
} from '../domain/ports';
import {
  openForEnrollment,
  stampedAt,
  type Halaqa,
  type Program,
  type Section,
} from '../domain/structure';
import { assignmentEnded, type TeacherAssignment } from '../domain/teacher-assignment';

type Ordered = { readonly order: number; readonly code: string };

function byOrder(a: Ordered, b: Ordered): number {
  return a.order - b.order || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
}

function compareKeys(a: Keyset, b: Keyset): number {
  const byTime = a.at.getTime() - b.at.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const enrollmentKey = (e: Enrollment): Keyset => ({ at: e.enrolledAt, id: e.id });
const assignmentKey = (a: TeacherAssignment): Keyset => ({ at: a.startedAt, id: a.id });

/**
 * Academic without a database — for development and unit tests. It keeps the
 * same invariants the schema does (unique codes, one ACTIVE enrollment per
 * student and halaqa, one ACTIVE assignment per teacher and halaqa, caps,
 * no ACTIVE enrollment in an INACTIVE halaqa), so a use case cannot pass here
 * and fail on Postgres over a rule this forgot. Single-threaded JavaScript is
 * its lock: every method below completes its check and its write without an
 * `await` in between.
 */
@Injectable()
export class InMemoryAcademicStore implements AcademicRepository, AcademicReadModel {
  private readonly sections = new Map<string, Section>();
  private readonly programs = new Map<string, Program>();
  private readonly halaqat = new Map<string, Halaqa>();
  private readonly enrollments = new Map<string, Enrollment>();
  private readonly assignments = new Map<string, TeacherAssignment>();

  // ── Structure ──────────────────────────────────────────────────────────

  async findSection(id: string): Promise<Section | null> {
    return this.sections.get(id) ?? null;
  }

  async findProgram(id: string): Promise<Program | null> {
    return this.programs.get(id) ?? null;
  }

  async findHalaqa(id: string): Promise<Halaqa | null> {
    return this.halaqat.get(id) ?? null;
  }

  async placement(halaqaId: string): Promise<Placement | null> {
    return this.placed(halaqaId);
  }

  async sectionByCode(code: string): Promise<Section | null> {
    return [...this.sections.values()].find((s) => s.code === code) ?? null;
  }

  async programByCode(code: string): Promise<Program | null> {
    return [...this.programs.values()].find((p) => p.code === code) ?? null;
  }

  async halaqaByCode(code: string): Promise<Halaqa | null> {
    return [...this.halaqat.values()].find((h) => h.code === code) ?? null;
  }

  async createSection(section: Section, limit: number): Promise<CreateOutcome> {
    if (this.sections.size >= limit) return { kind: 'limit_reached', limit };
    if ([...this.sections.values()].some((s) => s.code === section.code)) {
      return { kind: 'code_taken' };
    }
    this.sections.set(section.id, section);
    return { kind: 'created' };
  }

  async createProgram(program: Program, limit: number): Promise<CreateOutcome> {
    if (!this.sections.has(program.sectionId)) return { kind: 'parent_not_found' };
    const siblings = [...this.programs.values()].filter((p) => p.sectionId === program.sectionId);
    if (siblings.length >= limit) return { kind: 'limit_reached', limit };
    if ([...this.programs.values()].some((p) => p.code === program.code)) {
      return { kind: 'code_taken' };
    }
    this.programs.set(program.id, program);
    return { kind: 'created' };
  }

  async createHalaqa(halaqa: Halaqa, limit: number): Promise<CreateOutcome> {
    if (!this.programs.has(halaqa.programId)) return { kind: 'parent_not_found' };
    const siblings = [...this.halaqat.values()].filter((h) => h.programId === halaqa.programId);
    if (siblings.length >= limit) return { kind: 'limit_reached', limit };
    if ([...this.halaqat.values()].some((h) => h.code === halaqa.code)) {
      return { kind: 'code_taken' };
    }
    this.halaqat.set(halaqa.id, halaqa);
    return { kind: 'created' };
  }

  async saveSection(section: Section): Promise<void> {
    const stored = this.sections.get(section.id);
    if (stored === undefined) return;
    this.sections.set(section.id, {
      ...stored,
      name: section.name,
      order: section.order,
      description: section.description,
      updatedAt: section.updatedAt,
    });
  }

  async saveProgram(program: Program): Promise<void> {
    const stored = this.programs.get(program.id);
    if (stored === undefined) return;
    this.programs.set(program.id, {
      ...stored,
      name: program.name,
      order: program.order,
      description: program.description,
      updatedAt: program.updatedAt,
    });
  }

  async saveHalaqa(halaqa: Halaqa): Promise<void> {
    const stored = this.halaqat.get(halaqa.id);
    if (stored === undefined) return;
    this.halaqat.set(halaqa.id, {
      ...stored,
      name: halaqa.name,
      order: halaqa.order,
      updatedAt: halaqa.updatedAt,
    });
  }

  async setSectionStatus(
    id: string,
    status: StructureStatus,
    at: Date,
  ): Promise<StatusOutcome<Section>> {
    return this.setStatus(this.sections, id, status, at);
  }

  async setProgramStatus(
    id: string,
    status: StructureStatus,
    at: Date,
  ): Promise<StatusOutcome<Program>> {
    return this.setStatus(this.programs, id, status, at);
  }

  async activateHalaqa(id: string, at: Date): Promise<StatusOutcome<Halaqa>> {
    return this.setStatus(this.halaqat, id, 'ACTIVE', at);
  }

  async deactivateHalaqa(
    id: string,
    at: Date,
  ): Promise<StatusOutcome<Halaqa> | { readonly kind: 'has_active_enrollments' }> {
    const halaqa = this.halaqat.get(id);
    if (halaqa === undefined) return { kind: 'not_found' };
    if (halaqa.status === 'INACTIVE') return { kind: 'unchanged', entity: halaqa };
    const busy = [...this.enrollments.values()].some(
      (e) => e.halaqaId === id && e.status === 'ACTIVE',
    );
    if (busy) return { kind: 'has_active_enrollments' };
    return this.setStatus(this.halaqat, id, 'INACTIVE', at);
  }

  private setStatus<T extends Section | Program | Halaqa>(
    table: Map<string, T>,
    id: string,
    status: StructureStatus,
    at: Date,
  ): StatusOutcome<T> {
    const entity = table.get(id);
    if (entity === undefined) return { kind: 'not_found' };
    if (entity.status === status) return { kind: 'unchanged', entity };
    const changed = { ...entity, status, updatedAt: stampedAt(entity, at) };
    table.set(id, changed);
    return { kind: 'changed', entity: changed };
  }

  // ── Enrollment ─────────────────────────────────────────────────────────

  async enroll(enrollment: Enrollment): Promise<EnrollOutcome> {
    const placement = this.placed(enrollment.halaqaId);
    if (placement === null) return { kind: 'halaqa_not_found' };
    const open = openForEnrollment(placement);
    if (!open.ok) return { kind: 'closed', failure: open.error };
    const existing = this.activeEnrollment(enrollment.studentUserId, enrollment.halaqaId);
    if (existing !== undefined) return { kind: 'existing', enrollment: existing, placement };
    this.enrollments.set(enrollment.id, enrollment);
    return { kind: 'created', enrollment, placement };
  }

  async findEnrollment(id: string): Promise<Enrollment | null> {
    return this.enrollments.get(id) ?? null;
  }

  async endEnrollment(
    id: string,
    outcome: EnrollmentOutcome,
    by: string | null,
    at: Date,
  ): Promise<EndOutcome<Enrollment>> {
    const enrollment = this.enrollments.get(id);
    if (enrollment === undefined) return { kind: 'not_found' };
    if (enrollment.status !== 'ACTIVE') return { kind: 'not_active', entity: enrollment };
    const next = ended(enrollment, outcome, by, at);
    this.enrollments.set(id, next);
    return { kind: 'ended', entity: next };
  }

  // ── Teaching ───────────────────────────────────────────────────────────

  async assignTeacher(assignment: TeacherAssignment): Promise<AssignOutcome> {
    if (!this.halaqat.has(assignment.halaqaId)) return { kind: 'halaqa_not_found' };
    const existing = [...this.assignments.values()].find(
      (a) =>
        a.halaqaId === assignment.halaqaId &&
        a.teacherUserId === assignment.teacherUserId &&
        a.status === 'ACTIVE',
    );
    if (existing !== undefined) return { kind: 'existing', assignment: existing };
    this.assignments.set(assignment.id, assignment);
    return { kind: 'created', assignment };
  }

  async findAssignment(id: string): Promise<TeacherAssignment | null> {
    return this.assignments.get(id) ?? null;
  }

  async endAssignment(
    id: string,
    by: string | null,
    at: Date,
  ): Promise<EndOutcome<TeacherAssignment>> {
    const assignment = this.assignments.get(id);
    if (assignment === undefined) return { kind: 'not_found' };
    if (assignment.status !== 'ACTIVE') return { kind: 'not_active', entity: assignment };
    const next = assignmentEnded(assignment, by, at);
    this.assignments.set(id, next);
    return { kind: 'ended', entity: next };
  }

  async isEnrolled(studentUserId: string, halaqaId: string): Promise<boolean> {
    return this.activeEnrollment(studentUserId, halaqaId) !== undefined;
  }

  async isTeaching(teacherUserId: string, halaqaId: string): Promise<boolean> {
    return [...this.assignments.values()].some(
      (a) => a.halaqaId === halaqaId && a.teacherUserId === teacherUserId && a.status === 'ACTIVE',
    );
  }

  // ── Read model ─────────────────────────────────────────────────────────

  async catalogue(): Promise<Catalogue> {
    const programs = [...this.programs.values()].sort(byOrder);
    return {
      sections: [...this.sections.values()].sort(byOrder),
      programs,
      activeHalaqaCounts: this.counts(programs),
    };
  }

  async sectionCatalogue(sectionId: string): Promise<Catalogue | null> {
    const section = this.sections.get(sectionId);
    if (section === undefined) return null;
    const programs = [...this.programs.values()]
      .filter((p) => p.sectionId === sectionId)
      .sort(byOrder);
    return { sections: [section], programs, activeHalaqaCounts: this.counts(programs) };
  }

  async halaqatOf(programId: string): Promise<readonly Halaqa[]> {
    return [...this.halaqat.values()].filter((h) => h.programId === programId).sort(byOrder);
  }

  async roster(
    halaqaId: string,
    status: EnrollmentStatus,
    page: { readonly after?: Keyset; readonly limit: number },
  ): Promise<readonly Enrollment[]> {
    return [...this.enrollments.values()]
      .filter((e) => e.halaqaId === halaqaId && e.status === status)
      .filter((e) => page.after === undefined || compareKeys(enrollmentKey(e), page.after) > 0)
      .sort((a, b) => compareKeys(enrollmentKey(a), enrollmentKey(b)))
      .slice(0, page.limit);
  }

  async teachersOf(
    halaqaId: string,
    status: AssignmentStatus,
    page: { readonly after?: Keyset; readonly limit: number },
  ): Promise<readonly TeacherAssignment[]> {
    return [...this.assignments.values()]
      .filter((a) => a.halaqaId === halaqaId && a.status === status)
      .filter((a) => page.after === undefined || compareKeys(assignmentKey(a), page.after) > 0)
      .sort((a, b) => compareKeys(assignmentKey(a), assignmentKey(b)))
      .slice(0, page.limit);
  }

  async activeTeachersOf(halaqaIds: readonly string[]): Promise<readonly TeacherAssignment[]> {
    const wanted = new Set(halaqaIds);
    return [...this.assignments.values()]
      .filter((a) => wanted.has(a.halaqaId) && a.status === 'ACTIVE')
      .sort((a, b) => compareKeys(assignmentKey(a), assignmentKey(b)));
  }

  async enrollmentsOf(
    studentUserId: string,
    page: { readonly before?: Keyset; readonly limit: number },
  ): Promise<readonly PlacedEnrollment[]> {
    return [...this.enrollments.values()]
      .filter((e) => e.studentUserId === studentUserId)
      .filter((e) => page.before === undefined || compareKeys(enrollmentKey(e), page.before) < 0)
      .sort((a, b) => compareKeys(enrollmentKey(b), enrollmentKey(a)))
      .slice(0, page.limit)
      .flatMap((enrollment) => this.withPlacement(enrollment.halaqaId, { enrollment }));
  }

  async activeEnrollmentsOf(
    studentUserId: string,
    limit: number,
  ): Promise<readonly PlacedEnrollment[]> {
    return [...this.enrollments.values()]
      .filter((e) => e.studentUserId === studentUserId && e.status === 'ACTIVE')
      .sort((a, b) => compareKeys(enrollmentKey(a), enrollmentKey(b)))
      .slice(0, limit)
      .flatMap((enrollment) => this.withPlacement(enrollment.halaqaId, { enrollment }));
  }

  async assignmentsOf(
    teacherUserId: string,
    page: { readonly before?: Keyset; readonly limit: number },
  ): Promise<readonly PlacedAssignment[]> {
    return [...this.assignments.values()]
      .filter((a) => a.teacherUserId === teacherUserId)
      .filter((a) => page.before === undefined || compareKeys(assignmentKey(a), page.before) < 0)
      .sort((a, b) => compareKeys(assignmentKey(b), assignmentKey(a)))
      .slice(0, page.limit)
      .flatMap((assignment) => this.withPlacement(assignment.halaqaId, { assignment }));
  }

  async activeAssignmentsOf(
    teacherUserId: string,
    limit: number,
  ): Promise<readonly PlacedAssignment[]> {
    return [...this.assignments.values()]
      .filter((a) => a.teacherUserId === teacherUserId && a.status === 'ACTIVE')
      .sort((a, b) => compareKeys(assignmentKey(a), assignmentKey(b)))
      .slice(0, limit)
      .flatMap((assignment) => this.withPlacement(assignment.halaqaId, { assignment }));
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private placed(halaqaId: string): Placement | null {
    const halaqa = this.halaqat.get(halaqaId);
    const program = halaqa === undefined ? undefined : this.programs.get(halaqa.programId);
    const section = program === undefined ? undefined : this.sections.get(program.sectionId);
    if (halaqa === undefined || program === undefined || section === undefined) return null;
    return { halaqa, program, section };
  }

  private withPlacement<T extends object>(halaqaId: string, extra: T): (Placement & T)[] {
    const placement = this.placed(halaqaId);
    return placement === null ? [] : [{ ...placement, ...extra }];
  }

  private activeEnrollment(studentUserId: string, halaqaId: string): Enrollment | undefined {
    return [...this.enrollments.values()].find(
      (e) => e.studentUserId === studentUserId && e.halaqaId === halaqaId && e.status === 'ACTIVE',
    );
  }

  private counts(programs: readonly Program[]): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    const ids = new Set(programs.map((p) => p.id));
    for (const halaqa of this.halaqat.values()) {
      if (halaqa.status !== 'ACTIVE' || !ids.has(halaqa.programId)) continue;
      counts.set(halaqa.programId, (counts.get(halaqa.programId) ?? 0) + 1);
    }
    return counts;
  }
}

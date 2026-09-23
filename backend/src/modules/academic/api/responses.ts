import type {
  AssignmentStatus,
  EnrollmentStatus,
  SectionKind,
  StructureStatus,
  TeachingRole,
} from '../contracts/vocabulary';
import type {
  AssignmentView,
  CatalogueSectionView,
  EnrollmentView,
  HalaqaDetailView,
  HalaqaView,
  MyAcademicView,
  PageView,
  PersonView,
  PlacedAssignmentView,
  PlacedEnrollmentView,
  PlacementView,
  ProgramDetailView,
  ProgramView,
  RosterEntryView,
  SectionView,
  TeacherEntryView,
} from '../application/views';

/** Wire shapes: explicit, flat where possible, ISO-8601 instants. */

export interface SectionResponse {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: SectionKind;
  readonly order: number;
  readonly description: string | null;
  readonly status: StructureStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProgramResponse {
  readonly id: string;
  readonly code: string;
  readonly sectionId: string;
  readonly name: string;
  readonly order: number;
  readonly description: string | null;
  readonly status: StructureStatus;
  readonly activeHalaqaCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HalaqaResponse {
  readonly id: string;
  readonly code: string;
  readonly programId: string;
  readonly name: string;
  readonly order: number;
  readonly status: StructureStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CatalogueSectionResponse extends SectionResponse {
  readonly programs: readonly ProgramResponse[];
}

export interface EnrollmentResponse {
  readonly id: string;
  readonly studentUserId: string;
  readonly halaqaId: string;
  readonly status: EnrollmentStatus;
  readonly enrolledAt: string;
  readonly endedAt: string | null;
}

export interface AssignmentResponse {
  readonly id: string;
  readonly halaqaId: string;
  readonly teacherUserId: string;
  readonly role: TeachingRole;
  readonly status: AssignmentStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export type PlacementResponse = PlacementView;
export type PersonResponse = PersonView;

export interface PageResponse<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

const iso = (at: Date): string => at.toISOString();
const isoOrNull = (at: Date | null): string | null => (at === null ? null : at.toISOString());

export function toSectionResponse(view: SectionView): SectionResponse {
  return {
    id: view.id,
    code: view.code,
    name: view.name,
    kind: view.kind,
    order: view.order,
    description: view.description,
    status: view.status,
    createdAt: iso(view.createdAt),
    updatedAt: iso(view.updatedAt),
  };
}

export function toProgramResponse(view: ProgramView): ProgramResponse {
  return {
    id: view.id,
    code: view.code,
    sectionId: view.sectionId,
    name: view.name,
    order: view.order,
    description: view.description,
    status: view.status,
    activeHalaqaCount: view.activeHalaqaCount,
    createdAt: iso(view.createdAt),
    updatedAt: iso(view.updatedAt),
  };
}

export function toHalaqaResponse(view: HalaqaView): HalaqaResponse {
  return {
    id: view.id,
    code: view.code,
    programId: view.programId,
    name: view.name,
    order: view.order,
    status: view.status,
    createdAt: iso(view.createdAt),
    updatedAt: iso(view.updatedAt),
  };
}

export function toCatalogueSectionResponse(view: CatalogueSectionView): CatalogueSectionResponse {
  return { ...toSectionResponse(view), programs: view.programs.map(toProgramResponse) };
}

export function toProgramDetailResponse(view: ProgramDetailView) {
  return {
    program: toProgramResponse(view.program),
    section: toSectionResponse(view.section),
    halaqat: view.halaqat.map(toHalaqaResponse),
  };
}

export function toHalaqaDetailResponse(view: HalaqaDetailView) {
  return {
    halaqa: toHalaqaResponse(view.halaqa),
    program: view.program,
    section: view.section,
  };
}

export function toEnrollmentResponse(view: EnrollmentView): EnrollmentResponse {
  return {
    id: view.id,
    studentUserId: view.studentUserId,
    halaqaId: view.halaqaId,
    status: view.status,
    enrolledAt: iso(view.enrolledAt),
    endedAt: isoOrNull(view.endedAt),
  };
}

export function toAssignmentResponse(view: AssignmentView): AssignmentResponse {
  return {
    id: view.id,
    halaqaId: view.halaqaId,
    teacherUserId: view.teacherUserId,
    role: view.role,
    status: view.status,
    startedAt: iso(view.startedAt),
    endedAt: isoOrNull(view.endedAt),
  };
}

export function toPlacedEnrollmentResponse(view: PlacedEnrollmentView) {
  return { enrollment: toEnrollmentResponse(view.enrollment), placement: view.placement };
}

export function toPlacedAssignmentResponse(view: PlacedAssignmentView) {
  return { assignment: toAssignmentResponse(view.assignment), placement: view.placement };
}

export function toRosterEntryResponse(view: RosterEntryView) {
  return { enrollment: toEnrollmentResponse(view.enrollment), student: view.student };
}

export function toTeacherEntryResponse(view: TeacherEntryView) {
  return { assignment: toAssignmentResponse(view.assignment), teacher: view.teacher };
}

export function toMyAcademicResponse(view: MyAcademicView) {
  return {
    enrollments: view.enrollments.map((entry) => ({
      ...toPlacedEnrollmentResponse(entry),
      teachers: entry.teachers,
    })),
    teaching: view.teaching.map(toPlacedAssignmentResponse),
    truncated: view.truncated,
  };
}

export function toPageResponse<T, R>(page: PageView<T>, map: (item: T) => R): PageResponse<R> {
  return { items: page.items.map(map), nextCursor: page.nextCursor };
}

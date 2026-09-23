import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import type { Principal } from '../../src/shared';
import { PolicyAuthorizationService } from '../../src/modules/identity/application/authorization.service';
import type {
  AccountDirectory,
  AccountSummary,
} from '../../src/modules/identity/contracts/account-directory';
import type { Permission } from '../../src/modules/identity/contracts/permissions';
import { PROVISIONAL_POLICY_RULES } from '../../src/modules/identity/domain/provisional-policy';
import type { KnownRoleCode } from '../../src/modules/identity/domain/role';
import { AcademicAccess } from '../../src/modules/academic/application/academic-access';
import { AcademicJournal } from '../../src/modules/academic/application/academic-journal';
import { AcademicPeople } from '../../src/modules/academic/application/academic-people';
import { AcademicRelationshipsService } from '../../src/modules/academic/application/academic-relationships.service';
import {
  GetCatalogueUseCase,
  GetHalaqaUseCase,
  GetProgramUseCase,
  GetSectionUseCase,
} from '../../src/modules/academic/application/catalogue.use-cases';
import {
  EndEnrollmentUseCase,
  EnrollStudentUseCase,
  ListHalaqaStudentsUseCase,
  ListStudentEnrollmentsUseCase,
} from '../../src/modules/academic/application/enrollment.use-cases';
import {
  GetMyAcademicUseCase,
  ListMyEnrollmentsUseCase,
  ListMyTeachingUseCase,
} from '../../src/modules/academic/application/my-academic.use-cases';
import {
  STRUCTURE_SEEDER,
  SeedInstitutionStructureUseCase,
} from '../../src/modules/academic/application/seed-structure.use-case';
import {
  ChangeHalaqaStatusUseCase,
  ChangeProgramStatusUseCase,
  ChangeSectionStatusUseCase,
  CreateHalaqaUseCase,
  CreateProgramUseCase,
  CreateSectionUseCase,
  UpdateHalaqaUseCase,
  UpdateProgramUseCase,
  UpdateSectionUseCase,
} from '../../src/modules/academic/application/structure.use-cases';
import {
  AssignTeacherUseCase,
  EndTeacherAssignmentUseCase,
  ListHalaqaTeachersUseCase,
  ListTeacherAssignmentsUseCase,
} from '../../src/modules/academic/application/teaching.use-cases';
import type { Halaqa } from '../../src/modules/academic/domain/structure';
import type {
  AcademicReadModel,
  AcademicRepository,
} from '../../src/modules/academic/domain/ports';
import { InMemoryAcademicStore } from '../../src/modules/academic/infrastructure/in-memory-academic-store';
import { AdjustableClock, RecordingAuditLog, RecordingEvents, expectOk } from './identity-harness';
import { principalWith } from './principals';

export const META = { correlationId: 'test-request' } as const;

/**
 * Identity's account directory as academic sees it — the real authorization
 * service over the provisional matrix decides who may study or teach, and it
 * counts its calls so a test can prove lookups are batched, never per row.
 */
export class CountingAccountDirectory implements AccountDirectory {
  readonly calls: { method: 'describe' | 'withPermission'; ids: number }[] = [];
  private readonly accounts = new Map<
    string,
    { displayName: string; active: boolean; roles: readonly KnownRoleCode[] }
  >();

  constructor(
    private readonly authorization = new PolicyAuthorizationService(PROVISIONAL_POLICY_RULES),
  ) {}

  add(
    userId: string,
    roles: readonly KnownRoleCode[],
    options: { displayName?: string; active?: boolean } = {},
  ): void {
    this.accounts.set(userId, {
      displayName: options.displayName ?? userId,
      active: options.active ?? true,
      roles,
    });
  }

  setActive(userId: string, active: boolean): void {
    const account = this.accounts.get(userId);
    if (account !== undefined) this.accounts.set(userId, { ...account, active });
  }

  setRoles(userId: string, roles: readonly KnownRoleCode[]): void {
    const account = this.accounts.get(userId);
    if (account !== undefined) this.accounts.set(userId, { ...account, roles });
  }

  forget(userId: string): void {
    this.accounts.delete(userId);
  }

  async describe(userIds: readonly string[]): Promise<readonly AccountSummary[]> {
    this.calls.push({ method: 'describe', ids: userIds.length });
    return [...new Set(userIds)].flatMap((userId) => {
      const account = this.accounts.get(userId);
      return account === undefined
        ? []
        : [{ userId, displayName: account.displayName, active: account.active }];
    });
  }

  async withPermission(
    userIds: readonly string[],
    permission: Permission,
  ): Promise<ReadonlySet<string>> {
    this.calls.push({ method: 'withPermission', ids: userIds.length });
    return new Set(
      userIds.filter((userId) => {
        const account = this.accounts.get(userId);
        return (
          account !== undefined &&
          account.active &&
          this.authorization.can(principalWith(userId, account.roles), permission)
        );
      }),
    );
  }
}

/**
 * The academic application layer, wired by hand over the in-memory store (or
 * any adapters passed in — the Postgres suite runs the same use cases over
 * Drizzle), with a clock the test controls and every audit entry and event
 * recorded.
 */
export function academicHarness(
  options: {
    readonly repository?: AcademicRepository;
    readonly readModel?: AcademicReadModel;
  } = {},
) {
  const clock = new AdjustableClock();
  const memory = new InMemoryAcademicStore();
  const repository = options.repository ?? memory;
  const readModel = options.readModel ?? memory;
  const ids = new UuidIdGenerator();
  const authorization = new PolicyAuthorizationService(PROVISIONAL_POLICY_RULES);
  const directory = new CountingAccountDirectory(authorization);
  const audit = new RecordingAuditLog();
  const events = new RecordingEvents();

  const access = new AcademicAccess(authorization, repository);
  const people = new AcademicPeople(directory);
  const journal = new AcademicJournal(audit, events);

  const h = {
    clock,
    ids,
    repository,
    readModel,
    memory,
    authorization,
    directory,
    audit,
    events,
    catalogue: new GetCatalogueUseCase(access, readModel),
    getSection: new GetSectionUseCase(access, readModel),
    getProgram: new GetProgramUseCase(access, repository, readModel),
    getHalaqa: new GetHalaqaUseCase(access, repository),
    createSection: new CreateSectionUseCase(access, journal, repository, clock, ids),
    updateSection: new UpdateSectionUseCase(access, journal, repository, clock),
    sectionStatus: new ChangeSectionStatusUseCase(access, journal, repository, clock),
    createProgram: new CreateProgramUseCase(access, journal, repository, clock, ids),
    updateProgram: new UpdateProgramUseCase(access, journal, repository, readModel, clock),
    programStatus: new ChangeProgramStatusUseCase(access, journal, repository, readModel, clock),
    createHalaqa: new CreateHalaqaUseCase(access, journal, repository, clock, ids),
    updateHalaqa: new UpdateHalaqaUseCase(access, journal, repository, clock),
    halaqaStatus: new ChangeHalaqaStatusUseCase(access, journal, repository, clock),
    enroll: new EnrollStudentUseCase(access, people, journal, repository, clock, ids),
    endEnrollment: new EndEnrollmentUseCase(access, journal, repository, clock),
    students: new ListHalaqaStudentsUseCase(access, people, readModel),
    studentEnrollments: new ListStudentEnrollmentsUseCase(access, readModel),
    assign: new AssignTeacherUseCase(access, people, journal, repository, clock, ids),
    endAssignment: new EndTeacherAssignmentUseCase(access, journal, repository, clock),
    teachers: new ListHalaqaTeachersUseCase(access, people, readModel),
    teacherAssignments: new ListTeacherAssignmentsUseCase(access, readModel),
    me: new GetMyAcademicUseCase(access, people, readModel),
    myEnrollments: new ListMyEnrollmentsUseCase(access, readModel),
    myTeaching: new ListMyTeachingUseCase(access, readModel),
    seed: new SeedInstitutionStructureUseCase(access, journal, repository, clock, ids),
    relationships: new AcademicRelationshipsService(repository, readModel),

    /** A person with an account in identity, and the principal they sign in as. */
    person(
      userId: string,
      roles: readonly KnownRoleCode[],
      options: { displayName?: string; active?: boolean } = {},
    ): Principal {
      directory.add(userId, roles, options);
      return principalWith(userId, roles);
    },

    /** The institution's structure, seeded from its profile. */
    async seedProfile(): Promise<void> {
      expectOk(await h.seed.execute({ principal: STRUCTURE_SEEDER, meta: META }));
    },

    async halaqa(code: string): Promise<Halaqa> {
      const halaqa = await repository.halaqaByCode(code);
      if (halaqa === null) throw new Error(`no halaqa ${code}`);
      return halaqa;
    },

    async enrollIn(admin: Principal, studentUserId: string, halaqaId: string) {
      return expectOk(
        await h.enroll.execute({ principal: admin, halaqaId, studentUserId, meta: META }),
      ).enrollment;
    },

    async assignTo(
      admin: Principal,
      teacherUserId: string,
      halaqaId: string,
      role: 'TEACHER' | 'ASSISTANT_TEACHER' = 'TEACHER',
    ) {
      return expectOk(
        await h.assign.execute({ principal: admin, halaqaId, teacherUserId, role, meta: META }),
      ).assignment;
    },

    /** Everything recorded so far, as one string — for "never leaks" assertions. */
    recorded(): string {
      return JSON.stringify({ audit: audit.entries, events: events.published });
    },
  };
  return h;
}

export type AcademicHarness = ReturnType<typeof academicHarness>;

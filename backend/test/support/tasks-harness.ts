import {
  asId,
  err,
  failure,
  ok,
  type AuditEntry,
  type Clock,
  type DomainEvent,
  type IdGenerator,
  type Principal,
} from '../../src/shared';
import type { CommunityMembership } from '../../src/modules/communities/contracts';
import type { AccountDirectory } from '../../src/modules/identity/contracts/account-directory';
import type { AccountRoster } from '../../src/modules/identity/contracts/account-roster';
import type { AuthorizationService } from '../../src/modules/identity/contracts/authorization';
import { PROVISIONAL_ROLE_PERMISSIONS } from '../../src/modules/identity/domain/provisional-policy';
import { AudienceResolver } from '../../src/modules/tasks/application/audience-resolver';
import {
  ExportTasksUseCase,
  TaskDashboardUseCase,
} from '../../src/modules/tasks/application/dashboard/dashboard.use-cases';
import { CancelTaskUseCase } from '../../src/modules/tasks/application/manage/cancel-task.use-case';
import { EditTaskUseCase } from '../../src/modules/tasks/application/manage/edit-task.use-case';
import { PublishTaskUseCase } from '../../src/modules/tasks/application/manage/publish-task.use-case';
import {
  GetTaskUseCase,
  ListTasksUseCase,
  TaskHistoryUseCase,
  TrackTaskUseCase,
} from '../../src/modules/tasks/application/manage/read-tasks.use-cases';
import { ReassignAssignmentUseCase } from '../../src/modules/tasks/application/manage/reassign-assignment.use-case';
import { RemindNonRespondersUseCase } from '../../src/modules/tasks/application/manage/remind-non-responders.use-case';
import { ReopenTaskUseCase } from '../../src/modules/tasks/application/manage/reopen-task.use-case';
import { PersonNames } from '../../src/modules/tasks/application/person-names';
import {
  DeleteReportUseCase,
  EditReportUseCase,
} from '../../src/modules/tasks/application/reports/administer-report.use-cases';
import {
  GetReportUseCase,
  ListReportsUseCase,
} from '../../src/modules/tasks/application/reports/read-reports.use-cases';
import { ReportWriter } from '../../src/modules/tasks/application/reports/report-writer';
import { ReviewReportUseCase } from '../../src/modules/tasks/application/reports/review-report.use-case';
import { AcknowledgeTaskUseCase } from '../../src/modules/tasks/application/respond/acknowledge-task.use-case';
import { CompleteTaskUseCase } from '../../src/modules/tasks/application/respond/complete-task.use-case';
import { OwnTaskLoader } from '../../src/modules/tasks/application/respond/own-task';
import {
  GetMyTaskByTaskUseCase,
  GetMyTaskUseCase,
  ListMyTasksUseCase,
} from '../../src/modules/tasks/application/respond/read-my-tasks.use-cases';
import { WriteOwnReportUseCase } from '../../src/modules/tasks/application/respond/write-own-report.use-case';
import { TaskPublisher } from '../../src/modules/tasks/application/task-publisher';
import { TasksAccess } from '../../src/modules/tasks/application/tasks-access';
import { TasksJournal } from '../../src/modules/tasks/application/tasks-journal';
import { RepublishTaskUseCase } from '../../src/modules/tasks/application/templates/republish-task.use-case';
import {
  DeleteTemplateUseCase,
  ListTemplatesUseCase,
  SaveTemplateUseCase,
} from '../../src/modules/tasks/application/templates/template.use-cases';
import type {
  AssignmentRepository,
  ReportRepository,
  TaskEventLog,
  TaskRepository,
  TemplateRepository,
} from '../../src/modules/tasks/domain/ports';
import type { TaskReadModel, TaskStatistics } from '../../src/modules/tasks/domain/read-ports';
import { InMemoryAssignmentRepository } from '../../src/modules/tasks/infrastructure/in-memory-assignment-repository';
import { InMemoryReportRepository } from '../../src/modules/tasks/infrastructure/in-memory-report-repository';
import { InMemoryTaskEventLog } from '../../src/modules/tasks/infrastructure/in-memory-task-event-log';
import { InMemoryTaskReadModel } from '../../src/modules/tasks/infrastructure/in-memory-task-read-model';
import { InMemoryTaskRepository } from '../../src/modules/tasks/infrastructure/in-memory-task-repository';
import { InMemoryTaskStatistics } from '../../src/modules/tasks/infrastructure/in-memory-task-statistics';
import { InMemoryTasksState } from '../../src/modules/tasks/infrastructure/in-memory-tasks-state';
import { InMemoryTemplateRepository } from '../../src/modules/tasks/infrastructure/in-memory-template-repository';

/** One adapter's seven ports. */
export interface TasksPorts {
  readonly tasks: TaskRepository;
  readonly assignments: AssignmentRepository;
  readonly reports: ReportRepository;
  readonly log: TaskEventLog;
  readonly templates: TemplateRepository;
  readonly reads: TaskReadModel;
  readonly statistics: TaskStatistics;
}

export function inMemoryTasksPorts(): TasksPorts {
  const state = new InMemoryTasksState();
  return {
    tasks: new InMemoryTaskRepository(state),
    assignments: new InMemoryAssignmentRepository(state),
    reports: new InMemoryReportRepository(state),
    log: new InMemoryTaskEventLog(state),
    templates: new InMemoryTemplateRepository(state),
    reads: new InMemoryTaskReadModel(state),
    statistics: new InMemoryTaskStatistics(state),
  };
}

/** An account in the fake directory. */
export interface Person {
  readonly id: string;
  readonly roles: readonly string[];
  readonly active?: boolean;
}

/** A clock the test moves by hand, one second per read so every act is ordered. */
export class SteppingClock implements Clock {
  private at = new Date('2026-11-02T08:00:00.000Z').getTime();
  now(): Date {
    this.at += 1000;
    return new Date(this.at);
  }
}

/** The principal of a person, with the permissions their roles really carry. */
export function principalOf(person: Person): Principal {
  const matrix = PROVISIONAL_ROLE_PERMISSIONS as Record<string, readonly string[]>;
  return {
    userId: person.id,
    roles: person.roles,
    permissions: new Set(person.roles.flatMap((role) => matrix[role] ?? [])),
  };
}

/**
 * Every tasks use case over the given ports, with the real permission matrix
 * and small fakes for identity (authorization, roster, names) and communities
 * (members of a group). Audit entries and published facts are recorded.
 */
export function tasksHarness(
  ports: TasksPorts,
  people: readonly Person[],
  communities: Readonly<Record<string, readonly string[]>> = {},
) {
  const clock = new SteppingClock();
  let seq = 0;
  const ids: IdGenerator = {
    next: <T extends string>() => asId<T>(`id-${String(++seq).padStart(5, '0')}`),
  };
  const audit: AuditEntry[] = [];
  const facts: DomainEvent[] = [];
  const active = (p: Person) => p.active !== false;

  const authorization: AuthorizationService = {
    can: (principal, permission) => principal.permissions.has(permission),
    authorize: (principal, permission) =>
      principal.permissions.has(permission)
        ? ok(undefined)
        : err(failure('forbidden', 'identity.permission_denied', 'denied')),
  };
  const roster: AccountRoster = {
    activeWithRoles: async (roles, page) => {
      const ids = people
        .filter(
          (p) =>
            active(p) &&
            p.roles.some((r) => roles.includes(r)) &&
            (page.cursor == null || p.id > page.cursor),
        )
        .map((p) => p.id)
        .sort();
      const userIds = ids.slice(0, page.limit);
      return {
        userIds,
        nextCursor: ids.length > page.limit ? (userIds[userIds.length - 1] ?? null) : null,
      };
    },
    activeAmong: async (userIds, roles) =>
      new Set(
        people
          .filter(
            (p) => userIds.includes(p.id) && active(p) && p.roles.some((r) => roles.includes(r)),
          )
          .map((p) => p.id),
      ),
  };
  const membership = {
    heads: async (communityIds: readonly string[]) =>
      communityIds.filter((id) => id in communities).map((communityId) => ({ communityId })),
    members: async (communityId: string, page: { onlyUserIds?: readonly string[] }) => ({
      userIds: (communities[communityId] ?? []).filter(
        (id) => page.onlyUserIds?.includes(id) ?? true,
      ),
      nextCursor: null,
    }),
  } as unknown as CommunityMembership;
  const directory = {
    describe: async (userIds: readonly string[]) =>
      people
        .filter((p) => userIds.includes(p.id))
        .map((p) => ({
          userId: p.id,
          displayName: `name:${p.id}`,
          avatarFileAssetId: null,
          active: active(p),
        })),
  } as unknown as AccountDirectory;

  const access = new TasksAccess(authorization);
  const journal = new TasksJournal(
    { record: async (entry) => void audit.push(entry) },
    { publish: async (events) => void facts.push(...events) },
  );
  const audience = new AudienceResolver(roster, membership);
  const names = new PersonNames(directory);
  const publisher = new TaskPublisher(ports.tasks, audience, journal, clock, ids);
  const writer = new ReportWriter(ports.reports, ports.tasks, journal, clock);
  const own = new OwnTaskLoader(access, ports.assignments, ports.tasks);
  const getMine = new GetMyTaskUseCase(own, ports.reports);

  return {
    clock,
    audit,
    facts,
    principal: (id: string) => principalOf(people.find((p) => p.id === id) ?? { id, roles: [] }),
    publish: new PublishTaskUseCase(access, publisher, ports.templates),
    edit: new EditTaskUseCase(access, ports.tasks, ports.assignments, ports.reads, journal, clock),
    cancel: new CancelTaskUseCase(access, ports.tasks, ports.assignments, journal, clock),
    reopen: new ReopenTaskUseCase(access, ports.tasks, journal, clock),
    remind: new RemindNonRespondersUseCase(
      access,
      ports.tasks,
      ports.assignments,
      ports.log,
      journal,
      clock,
    ),
    reassign: new ReassignAssignmentUseCase(
      access,
      ports.tasks,
      ports.assignments,
      audience,
      journal,
      clock,
      ids,
    ),
    list: new ListTasksUseCase(access, ports.reads),
    get: new GetTaskUseCase(access, ports.tasks, ports.reads, names),
    track: new TrackTaskUseCase(access, ports.tasks, ports.assignments, ports.reports, names),
    history: new TaskHistoryUseCase(access, ports.tasks, ports.log, names),
    listMine: new ListMyTasksUseCase(access, ports.reads),
    getMine,
    getMineByTask: new GetMyTaskByTaskUseCase(access, ports.assignments, getMine),
    acknowledge: new AcknowledgeTaskUseCase(own, ports.assignments, ports.tasks, journal, clock),
    complete: new CompleteTaskUseCase(own, ports.assignments, ports.tasks, journal, clock, ids),
    writeReport: new WriteOwnReportUseCase(own, ports.reports, writer),
    listReports: new ListReportsUseCase(access, ports.reads, names),
    getReport: new GetReportUseCase(access, ports.reports, ports.tasks, names),
    review: new ReviewReportUseCase(access, ports.reports, ports.tasks, journal, clock, ids),
    editReport: new EditReportUseCase(access, ports.reports, ports.tasks, writer),
    deleteReport: new DeleteReportUseCase(access, ports.reports, journal, clock),
    saveTemplate: new SaveTemplateUseCase(
      access,
      ports.templates,
      ports.tasks,
      journal,
      clock,
      ids,
    ),
    listTemplates: new ListTemplatesUseCase(access, ports.templates),
    deleteTemplate: new DeleteTemplateUseCase(access, ports.templates, journal, clock),
    republish: new RepublishTaskUseCase(access, ports.tasks, publisher),
    dashboard: new TaskDashboardUseCase(access, ports.statistics, names),
    exportRows: new ExportTasksUseCase(access, ports.statistics, names),
  };
}

export type TasksHarness = ReturnType<typeof tasksHarness>;

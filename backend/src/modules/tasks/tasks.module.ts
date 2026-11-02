import { Module } from '@nestjs/common';

import { CommunitiesModule } from '../communities/communities.module';
import { IdentityModule } from '../identity/identity.module';
import { MyTasksController } from './api/my-tasks.controller';
import { TaskDashboardController } from './api/task-dashboard.controller';
import { TaskReportsController } from './api/task-reports.controller';
import { TaskTemplatesController } from './api/task-templates.controller';
import { TasksController } from './api/tasks.controller';
import { AudienceResolver } from './application/audience-resolver';
import {
  ExportTasksUseCase,
  TaskDashboardUseCase,
} from './application/dashboard/dashboard.use-cases';
import { CancelTaskUseCase } from './application/manage/cancel-task.use-case';
import { EditTaskUseCase } from './application/manage/edit-task.use-case';
import { PublishTaskUseCase } from './application/manage/publish-task.use-case';
import {
  GetTaskUseCase,
  ListTasksUseCase,
  TaskHistoryUseCase,
  TrackTaskUseCase,
} from './application/manage/read-tasks.use-cases';
import { ReassignAssignmentUseCase } from './application/manage/reassign-assignment.use-case';
import { RemindNonRespondersUseCase } from './application/manage/remind-non-responders.use-case';
import { ReopenTaskUseCase } from './application/manage/reopen-task.use-case';
import { PersonNames } from './application/person-names';
import {
  DeleteReportUseCase,
  EditReportUseCase,
} from './application/reports/administer-report.use-cases';
import { GetReportUseCase, ListReportsUseCase } from './application/reports/read-reports.use-cases';
import { ReportWriter } from './application/reports/report-writer';
import { ReviewReportUseCase } from './application/reports/review-report.use-case';
import { AcknowledgeTaskUseCase } from './application/respond/acknowledge-task.use-case';
import { CompleteTaskUseCase } from './application/respond/complete-task.use-case';
import { OwnTaskLoader } from './application/respond/own-task';
import {
  GetMyTaskByTaskUseCase,
  GetMyTaskUseCase,
  ListMyTasksUseCase,
} from './application/respond/read-my-tasks.use-cases';
import { WriteOwnReportUseCase } from './application/respond/write-own-report.use-case';
import { TaskPublisher } from './application/task-publisher';
import { TasksAccess } from './application/tasks-access';
import { TasksJournal } from './application/tasks-journal';
import { RepublishTaskUseCase } from './application/templates/republish-task.use-case';
import {
  DeleteTemplateUseCase,
  ListTemplatesUseCase,
  SaveTemplateUseCase,
} from './application/templates/template.use-cases';
import { TASKS_PERSISTENCE_PROVIDERS } from './infrastructure/persistence.providers';

/**
 * Tasks — the daily tasks & reports engine (ADR 0052). It reaches identity for
 * authorization, names and the role roster (`ACCOUNT_ROSTER`), and communities
 * only for the members of a group a task is narrowed to (`COMMUNITY_MEMBERSHIP`).
 * It owns the `tasks_*` tables and exports nothing: other modules hear it only
 * through its events (`contracts/events.ts`).
 */
@Module({
  imports: [IdentityModule, CommunitiesModule],
  controllers: [
    TasksController,
    MyTasksController,
    TaskReportsController,
    TaskTemplatesController,
    TaskDashboardController,
  ],
  providers: [
    ...TASKS_PERSISTENCE_PROVIDERS,
    TasksAccess,
    TasksJournal,
    AudienceResolver,
    PersonNames,
    TaskPublisher,
    ReportWriter,
    OwnTaskLoader,
    PublishTaskUseCase,
    EditTaskUseCase,
    CancelTaskUseCase,
    ReopenTaskUseCase,
    RemindNonRespondersUseCase,
    ReassignAssignmentUseCase,
    ListTasksUseCase,
    GetTaskUseCase,
    TrackTaskUseCase,
    TaskHistoryUseCase,
    ListMyTasksUseCase,
    GetMyTaskUseCase,
    GetMyTaskByTaskUseCase,
    AcknowledgeTaskUseCase,
    CompleteTaskUseCase,
    WriteOwnReportUseCase,
    ListReportsUseCase,
    GetReportUseCase,
    ReviewReportUseCase,
    EditReportUseCase,
    DeleteReportUseCase,
    SaveTemplateUseCase,
    ListTemplatesUseCase,
    DeleteTemplateUseCase,
    RepublishTaskUseCase,
    TaskDashboardUseCase,
    ExportTasksUseCase,
  ],
})
export class TasksModule {}

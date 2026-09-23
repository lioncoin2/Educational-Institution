import { Module } from '@nestjs/common';

import { AcademicModule } from './modules/academic/academic.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { AutomationModule } from './modules/automation/automation.module';
import { CommunitiesModule } from './modules/communities/communities.module';
import { FilesModule } from './modules/files/files.module';
import { IdentityModule } from './modules/identity/identity.module';
import { LiveModule } from './modules/live/live.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OperationsModule } from './modules/operations/operations.module';
import { PeopleModule } from './modules/people/people.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { DatabaseModule } from './platform/database';
import { PlatformModule } from './platform/platform.module';

/**
 * The composition root.
 *
 * It only *lists* modules — it holds no logic of its own. Every module registers
 * its own controllers, providers and guards, which is what makes extracting one
 * into a separate service a mechanical change rather than a rewrite.
 */
@Module({
  imports: [
    PlatformModule,
    DatabaseModule,
    // Identity first: it registers the global authentication and permission guards.
    IdentityModule,
    PeopleModule,
    AcademicModule,
    CommunitiesModule,
    OperationsModule,
    AssignmentsModule,
    MessagingModule,
    LiveModule,
    FilesModule,
    NotificationsModule,
    RealtimeModule,
    AutomationModule,
    ReportingModule,
  ],
})
export class AppModule {}

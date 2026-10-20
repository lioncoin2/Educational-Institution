import { Module } from '@nestjs/common';

import { AcademicModule } from '../academic/academic.module';
import { CommunitiesModule } from '../communities/communities.module';
import { IdentityModule } from '../identity/identity.module';
import { ReportingController } from './api/reporting.controller';
import { COMMAND_ACTION_CATALOG } from './application/command-actions';
import { GetCommandCenterUseCase } from './application/get-command-center.use-case';
import { AccountsSummaryWidget } from './application/widgets/accounts-summary.widget';
import { AcademicStructureWidget } from './application/widgets/academic-structure.widget';
import { CommunitiesSummaryWidget } from './application/widgets/communities-summary.widget';
import { COMMAND_ACTIONS, WIDGET_PROVIDERS } from './contracts';

/**
 * Reporting — read models and the Owner Command Center (module-boundaries.md).
 *
 * The command center is a registry: every widget is a `WidgetProvider` bound
 * here into `WIDGET_PROVIDERS`, reading another module only through its public
 * `contracts/`. Adding a widget later is one provider + one line in the factory,
 * never a change to the resolver or the screen. Reporting owns the registry, so
 * no other module exports reporting's token (keeping each module's exports to
 * its own contracts). It reads; it never writes, and it stores no table.
 */
@Module({
  imports: [IdentityModule, CommunitiesModule, AcademicModule],
  controllers: [ReportingController],
  providers: [
    CommunitiesSummaryWidget,
    AcademicStructureWidget,
    AccountsSummaryWidget,
    {
      provide: WIDGET_PROVIDERS,
      inject: [CommunitiesSummaryWidget, AcademicStructureWidget, AccountsSummaryWidget],
      useFactory: (
        communities: CommunitiesSummaryWidget,
        academic: AcademicStructureWidget,
        accounts: AccountsSummaryWidget,
      ) => [communities, academic, accounts],
    },
    { provide: COMMAND_ACTIONS, useValue: COMMAND_ACTION_CATALOG },
    GetCommandCenterUseCase,
  ],
})
export class ReportingModule {}

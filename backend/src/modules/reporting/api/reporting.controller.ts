import { Controller, Get, UseInterceptors } from '@nestjs/common';

import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { DatabaseUnavailableInterceptor } from '../../../platform/http/database-unavailable.interceptor';
import { unwrap } from '../../../platform/http/http-failure';
import type { Principal } from '../../../shared';
import { Permissions, RequirePermission } from '../../identity/contracts';
import { GetCommandCenterUseCase } from '../application/get-command-center.use-case';
import { toCommandCenterResponse } from './responses';

/**
 * /reporting — read models for the Owner Command Center.
 *
 * The edge requires `reports.read`; the use case re-checks it and hides any
 * widget the viewer may not see. The store-unavailable interceptor answers 503
 * as on every data route. No route writes anything.
 */
@Controller('reporting')
@UseInterceptors(DatabaseUnavailableInterceptor)
export class ReportingController {
  constructor(private readonly commandCenter: GetCommandCenterUseCase) {}

  /** The widgets the viewer may see, each resolved to its current facts. */
  @Get('command-center')
  @RequirePermission(Permissions.reports.read)
  async getCommandCenter(@CurrentPrincipal() principal: Principal) {
    return toCommandCenterResponse(unwrap(await this.commandCenter.execute({ principal })));
  }
}

import { Body, Controller, Get, Put } from '@nestjs/common';

import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import type { Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import {
  GetInstitutionNotificationSettingsUseCase,
  UpdateInstitutionNotificationSettingsUseCase,
} from '../application/institution-settings.use-cases';
import { UpdateInstitutionSettingsDto } from './dto/notifications.dto';
import { toInstitutionSettingsResponse, type InstitutionSettingsResponse } from './responses';

/**
 * The institution-wide quiet-hours policy — an administrative setting, not a
 * person's. Reading and changing it both require `settings.manage` (owner-only,
 * the same authority as every other institution setting); no new permission is
 * introduced, and no administrator's existing reach is widened. This is
 * separate from the person's own settings on `NotificationsController`, which
 * are authenticated-and-self-scoped.
 */
@Controller('notifications/institution-settings')
export class InstitutionNotificationSettingsController {
  constructor(
    private readonly getSettings: GetInstitutionNotificationSettingsUseCase,
    private readonly updateSettings: UpdateInstitutionNotificationSettingsUseCase,
  ) {}

  @Get()
  @RequirePermission(Permissions.settings.manage)
  async get(): Promise<InstitutionSettingsResponse> {
    return toInstitutionSettingsResponse(unwrap(await this.getSettings.execute()));
  }

  @Put()
  @RequirePermission(Permissions.settings.manage)
  async update(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: UpdateInstitutionSettingsDto,
  ): Promise<InstitutionSettingsResponse> {
    return toInstitutionSettingsResponse(
      unwrap(
        await this.updateSettings.execute({
          principal,
          enabled: dto.enabled,
          start: dto.start,
          end: dto.end,
          timezone: dto.timezone,
        }),
      ),
    );
  }
}

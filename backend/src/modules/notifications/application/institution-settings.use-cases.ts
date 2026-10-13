import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, err, failure, ok, type Clock, type Principal, type Result } from '../../../shared';
import {
  NOTIFICATION_SETTINGS_REPOSITORY,
  type NotificationSettingsRepository,
} from '../domain/ports';
import { isValidTimezone, isValidWindow, type InstitutionQuietHours } from '../domain/quiet-hours';
import { toInstitutionQuietHoursView, type InstitutionQuietHoursView } from './views';

/**
 * The institution-wide quiet-hours policy. Reading and changing it are both an
 * administrative act — the route requires `settings.manage` (owner-only), the
 * same authority as every other institution setting. Nothing here is scoped to
 * the caller: it is the institution's policy, not a person's.
 */
@Injectable()
export class GetInstitutionNotificationSettingsUseCase {
  constructor(
    @Inject(NOTIFICATION_SETTINGS_REPOSITORY)
    private readonly settings: NotificationSettingsRepository,
  ) {}

  async execute(): Promise<Result<InstitutionQuietHoursView | null>> {
    const institution = await this.settings.institution();
    return ok(institution === null ? null : toInstitutionQuietHoursView(institution));
  }
}

/**
 * Sets the institution quiet-hours window and the timezone it is read in. The
 * window must be two distinct 'HH:MM' times (overnight is allowed); the
 * timezone must be an IANA zone the platform knows — a guessed or offset zone
 * is refused, because a window is a wall-clock policy that only a named zone
 * makes DST-correct. The window and zone are stored even when disabled, so
 * turning quiet hours back on restores them.
 */
@Injectable()
export class UpdateInstitutionNotificationSettingsUseCase {
  constructor(
    @Inject(NOTIFICATION_SETTINGS_REPOSITORY)
    private readonly settings: NotificationSettingsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly principal: Principal;
    readonly enabled: boolean;
    readonly start: string;
    readonly end: string;
    readonly timezone: string;
  }): Promise<Result<InstitutionQuietHoursView>> {
    const window = { start: input.start, end: input.end };
    if (!isValidWindow(window)) {
      return err(
        failure(
          'validation',
          'notifications.quiet_hours_window_invalid',
          'A quiet-hours window is two distinct times in HH:MM, 24-hour.',
          { start: input.start, end: input.end },
        ),
      );
    }
    if (!isValidTimezone(input.timezone)) {
      return err(
        failure(
          'validation',
          'notifications.timezone_invalid',
          'The timezone must be an IANA zone identifier, for example Asia/Baghdad.',
          { timezone: input.timezone },
        ),
      );
    }
    const settings: InstitutionQuietHours = {
      enabled: input.enabled,
      window,
      timezone: input.timezone,
    };
    await this.settings.saveInstitution(settings, this.clock.now(), input.principal.userId);
    return ok(toInstitutionQuietHoursView(settings));
  }
}

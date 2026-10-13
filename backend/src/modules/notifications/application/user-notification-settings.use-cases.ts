import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, err, failure, ok, type Clock, type Principal, type Result } from '../../../shared';
import {
  NOTIFICATION_SETTINGS_REPOSITORY,
  type NotificationSettingsRepository,
} from '../domain/ports';
import {
  isValidTimezone,
  isValidWindow,
  type UserNotificationSettings,
  type UserQuietHoursPreference,
} from '../domain/quiet-hours';
import { toUserNotificationSettingsView, type UserNotificationSettingsView } from './views';

/**
 * A person's own notification settings — their timezone, and their quiet-hours
 * choice. Scoped to the principal; there is no way to read or change anyone
 * else's. A user's own setting fully replaces the institution window for them
 * (they may inherit it, disable it, or set their own) — the owner's Q6
 * decision.
 */
@Injectable()
export class GetUserNotificationSettingsUseCase {
  constructor(
    @Inject(NOTIFICATION_SETTINGS_REPOSITORY)
    private readonly settings: NotificationSettingsRepository,
  ) {}

  async execute(input: {
    readonly principal: Principal;
  }): Promise<Result<UserNotificationSettingsView>> {
    const settings = await this.settings.getUserSettings(input.principal.userId);
    return ok(toUserNotificationSettingsView(settings));
  }
}

/**
 * Changes a person's timezone, their quiet-hours choice, or both. A PATCH: a
 * part left out is kept.
 *
 *   timezone        a valid IANA zone, or null to clear it (then the
 *                   institution's zone is used to read their hours)
 *   quietHoursMode  INHERIT (follow the institution window), DISABLED (none),
 *                   or CUSTOM (their own window — start and end then required)
 */
@Injectable()
export class UpdateUserNotificationSettingsUseCase {
  constructor(
    @Inject(NOTIFICATION_SETTINGS_REPOSITORY)
    private readonly settings: NotificationSettingsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly principal: Principal;
    /** undefined: keep. null: clear. string: set. */
    readonly timezone?: string | null;
    readonly quietHoursMode?: 'INHERIT' | 'DISABLED' | 'CUSTOM';
    readonly quietHoursStart?: string;
    readonly quietHoursEnd?: string;
  }): Promise<Result<UserNotificationSettingsView>> {
    const changesTimezone = input.timezone !== undefined;
    const changesQuietHours = input.quietHoursMode !== undefined;
    if (!changesTimezone && !changesQuietHours) {
      return err(
        failure(
          'validation',
          'notifications.settings_empty',
          'Say what to change: a timezone, a quiet-hours mode, or both.',
        ),
      );
    }

    const current = await this.settings.getUserSettings(input.principal.userId);

    let timezone = current.timezone;
    if (changesTimezone) {
      if (input.timezone !== null && !isValidTimezone(input.timezone)) {
        return err(
          failure(
            'validation',
            'notifications.timezone_invalid',
            'The timezone must be an IANA zone identifier, for example Asia/Baghdad.',
            { timezone: input.timezone },
          ),
        );
      }
      timezone = input.timezone;
    }

    let quietHours: UserQuietHoursPreference = current.quietHours;
    if (changesQuietHours) {
      const windowGiven = input.quietHoursStart !== undefined || input.quietHoursEnd !== undefined;
      if (input.quietHoursMode === 'CUSTOM') {
        if (input.quietHoursStart === undefined || input.quietHoursEnd === undefined) {
          return err(
            failure(
              'validation',
              'notifications.quiet_hours_window_required',
              'A custom quiet-hours mode needs a start and an end, each HH:MM.',
            ),
          );
        }
        const window = { start: input.quietHoursStart, end: input.quietHoursEnd };
        if (!isValidWindow(window)) {
          return err(
            failure(
              'validation',
              'notifications.quiet_hours_window_invalid',
              'A quiet-hours window is two distinct times in HH:MM, 24-hour.',
              { start: input.quietHoursStart, end: input.quietHoursEnd },
            ),
          );
        }
        quietHours = { mode: 'CUSTOM', window };
      } else {
        if (windowGiven) {
          return err(
            failure(
              'validation',
              'notifications.quiet_hours_window_unexpected',
              'Only a custom quiet-hours mode takes a window.',
            ),
          );
        }
        quietHours = { mode: input.quietHoursMode };
      }
    }

    const next: UserNotificationSettings = { timezone, quietHours };
    await this.settings.saveUserSettings(input.principal.userId, next, this.clock.now());
    return ok(toUserNotificationSettingsView(next));
  }
}

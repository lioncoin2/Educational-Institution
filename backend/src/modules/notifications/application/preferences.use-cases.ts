import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, err, failure, ok, type Clock, type Principal, type Result } from '../../../shared';
import { ACTIVE_CATEGORIES, isActiveCategory } from '../domain/catalog';
import { PREFERENCE_REPOSITORY, type PreferenceRepository } from '../domain/ports';
import { applyChange, preferencesFor, type StoredPreferences } from '../domain/preferences';
import type { CategoryPreferencesView } from './views';

function viewOf(stored: StoredPreferences | undefined): CategoryPreferencesView[] {
  return ACTIVE_CATEGORIES.map((category) => ({
    category,
    ...preferencesFor(stored, category),
  }));
}

/**
 * A person's own preferences — for the categories that have notifications
 * today, and only those. Scoped to the principal; there is no way to read or
 * change anyone else's.
 */
@Injectable()
export class GetNotificationPreferencesUseCase {
  constructor(@Inject(PREFERENCE_REPOSITORY) private readonly preferences: PreferenceRepository) {}

  async execute(input: {
    readonly principal: Principal;
  }): Promise<Result<CategoryPreferencesView[]>> {
    const stored = await this.preferences.forUsers([input.principal.userId]);
    return ok(viewOf(stored.get(input.principal.userId)));
  }
}

/**
 * Changes one category's channels; switches left out keep their value.
 *
 * Not audited: a preference is a person's choice about their own inbox and
 * grants nothing to anyone (the audit trail records who can receive push on
 * which device — see the device use cases).
 */
@Injectable()
export class UpdateNotificationPreferencesUseCase {
  constructor(
    @Inject(PREFERENCE_REPOSITORY) private readonly preferences: PreferenceRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly principal: Principal;
    readonly category: string;
    readonly inApp?: boolean;
    readonly realtime?: boolean;
    readonly push?: boolean;
  }): Promise<Result<CategoryPreferencesView[]>> {
    if (!isActiveCategory(input.category)) {
      return err(
        failure(
          'validation',
          'notifications.category_unknown',
          'There are no notifications of that category to set preferences for.',
          { category: input.category },
        ),
      );
    }
    if (input.inApp === undefined && input.realtime === undefined && input.push === undefined) {
      return err(
        failure(
          'validation',
          'notifications.preferences_empty',
          'Say which of inApp, realtime and push to change.',
        ),
      );
    }
    const userId = input.principal.userId;
    const stored = (await this.preferences.forUsers([userId])).get(userId);
    const next = applyChange(preferencesFor(stored, input.category), {
      inApp: input.inApp,
      realtime: input.realtime,
      push: input.push,
    });
    await this.preferences.save(userId, input.category, next, this.clock.now());
    const updated = new Map(stored ?? []);
    updated.set(input.category, next);
    return ok(viewOf(updated));
  }
}

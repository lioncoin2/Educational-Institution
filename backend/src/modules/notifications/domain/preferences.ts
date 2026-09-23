import type { NotificationCategory } from '../contracts/vocabulary';

/**
 * One person's choices for one category, channel by channel. Each is stored
 * separately and changed separately — turning push off never touches the
 * notification center.
 */
export interface ChannelPreferences {
  readonly inApp: boolean;
  readonly realtime: boolean;
  readonly push: boolean;
}

/**
 * Until a person says otherwise: everything on. The notification center is
 * the product; live updates cost nothing; push is sent only once a provider
 * is configured and a device registered, and even then says no more than
 * "a new message" on a lock screen (see `pushMessageFor`).
 *
 * PROVISIONAL, like every default here — see open-questions.md Q28.
 */
export const DEFAULT_CHANNEL_PREFERENCES: ChannelPreferences = Object.freeze({
  inApp: true,
  realtime: true,
  push: true,
});

export type PreferenceChange = Partial<ChannelPreferences>;

export function applyChange(
  current: ChannelPreferences,
  change: PreferenceChange,
): ChannelPreferences {
  return {
    inApp: change.inApp ?? current.inApp,
    realtime: change.realtime ?? current.realtime,
    push: change.push ?? current.push,
  };
}

/**
 * What a new notification in this category gets.
 *
 * IN_APP is the record itself: with it off nothing is stored, and the
 * delivery channels have nothing to deliver. With it on, each delivery
 * channel follows its own switch. The stored choices are kept as the person
 * set them either way, so turning the center back on restores their live
 * and push choices as they were.
 */
export function effectiveChannels(preferences: ChannelPreferences): {
  readonly store: boolean;
  readonly realtime: boolean;
  readonly push: boolean;
} {
  return {
    store: preferences.inApp,
    realtime: preferences.inApp && preferences.realtime,
    push: preferences.inApp && preferences.push,
  };
}

/** A person's stored choices, by category; categories absent use the defaults. */
export type StoredPreferences = ReadonlyMap<NotificationCategory, ChannelPreferences>;

export function preferencesFor(
  stored: StoredPreferences | undefined,
  category: NotificationCategory,
): ChannelPreferences {
  return stored?.get(category) ?? DEFAULT_CHANNEL_PREFERENCES;
}

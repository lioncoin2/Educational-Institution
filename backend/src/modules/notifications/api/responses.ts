import type {
  CategoryPreferencesView,
  DeviceView,
  InstitutionQuietHoursView,
  MutedConversationView,
  NotificationView,
  UnreadCountView,
  UserNotificationSettingsView,
} from '../application/views';

/**
 * Wire shapes, built field by field from the application's views — never a
 * row or a domain object spread onto the wire.
 */
export interface NotificationResponse {
  readonly id: string;
  readonly type: string;
  readonly category: string;
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly target: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export function toNotificationResponse(view: NotificationView): NotificationResponse {
  return {
    id: view.id,
    type: view.type,
    category: view.category,
    titleKey: view.titleKey,
    bodyKey: view.bodyKey,
    params: { ...view.params },
    target: { ...view.target },
    createdAt: view.createdAt.toISOString(),
    readAt: view.readAt === null ? null : view.readAt.toISOString(),
  };
}

export function toUnreadCountResponse(view: UnreadCountView): { count: number; capped: boolean } {
  return { count: view.count, capped: view.capped };
}

export interface PreferencesResponse {
  readonly categories: readonly {
    readonly category: string;
    readonly inApp: boolean;
    readonly realtime: boolean;
    readonly push: boolean;
  }[];
}

export function toPreferencesResponse(
  views: readonly CategoryPreferencesView[],
): PreferencesResponse {
  return {
    categories: views.map((view) => ({
      category: view.category,
      inApp: view.inApp,
      realtime: view.realtime,
      push: view.push,
    })),
  };
}

/** The institution quiet-hours policy, or null when none is configured. */
export interface InstitutionSettingsResponse {
  readonly settings: {
    readonly enabled: boolean;
    readonly start: string;
    readonly end: string;
    readonly timezone: string;
  } | null;
}

export function toInstitutionSettingsResponse(
  view: InstitutionQuietHoursView | null,
): InstitutionSettingsResponse {
  return {
    settings:
      view === null
        ? null
        : { enabled: view.enabled, start: view.start, end: view.end, timezone: view.timezone },
  };
}

export interface UserNotificationSettingsResponse {
  readonly timezone: string | null;
  readonly quietHoursMode: 'INHERIT' | 'DISABLED' | 'CUSTOM';
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
}

export function toUserNotificationSettingsResponse(
  view: UserNotificationSettingsView,
): UserNotificationSettingsResponse {
  return {
    timezone: view.timezone,
    quietHoursMode: view.quietHoursMode,
    quietHoursStart: view.quietHoursStart,
    quietHoursEnd: view.quietHoursEnd,
  };
}

export interface MutedConversationsResponse {
  readonly conversations: readonly { readonly conversationId: string; readonly mutedAt: string }[];
}

export function toMutedConversationsResponse(
  views: readonly MutedConversationView[],
): MutedConversationsResponse {
  return {
    conversations: views.map((view) => ({
      conversationId: view.conversationId,
      mutedAt: view.mutedAt.toISOString(),
    })),
  };
}

/** A device, without its token — ever. */
export interface DeviceResponse {
  readonly id: string;
  readonly platform: string;
  readonly provider: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

export function toDeviceResponse(view: DeviceView): DeviceResponse {
  return {
    id: view.id,
    platform: view.platform,
    provider: view.provider,
    createdAt: view.createdAt.toISOString(),
    lastSeenAt: view.lastSeenAt.toISOString(),
  };
}

/**
 * Notifications' public vocabulary — the codes clients, events and other
 * modules use. Upper-case codes, like every enumerated value in the API.
 */

/**
 * What a notification is about. A stable code: clients choose an icon and
 * wording by it, and one they do not know yet is shown as a generic
 * notification, never an error.
 *
 *   MESSAGE_RECEIVED        a new message in a conversation you are in
 *   CONVERSATION_CREATED    someone started a conversation that includes you
 *   ADDED_TO_CONVERSATION   someone added you to an existing conversation
 *
 * Reserved — named so the vocabulary is stable, but NOTHING creates them:
 * the modules whose facts they would announce publish no such events yet,
 * and the dispatcher refuses a type that is not active (see the catalog in
 * `domain/catalog.ts`). Activating one is a translator for the event its
 * module starts publishing, plus one line in the catalog.
 *
 *   ASSIGNMENT_CREATED, ASSIGNMENT_UPDATED   assignments
 *   ANNOUNCEMENT_CREATED                     announcements
 *   CERTIFICATE_ISSUED                       certificates
 *   HALAQA_UPDATE                            academic (halaqat)
 */
export const NOTIFICATION_TYPES = [
  'MESSAGE_RECEIVED',
  'CONVERSATION_CREATED',
  'ADDED_TO_CONVERSATION',
  'ASSIGNMENT_CREATED',
  'ASSIGNMENT_UPDATED',
  'ANNOUNCEMENT_CREATED',
  'CERTIFICATE_ISSUED',
  'HALAQA_UPDATE',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * What a person sets preferences for. One category per source of
 * notifications, not one per type: "messages" is a thing a person decides
 * about; "someone added me to a group" versus "someone started a group with
 * me" is not.
 */
export const NOTIFICATION_CATEGORIES = [
  'MESSAGES',
  'ASSIGNMENTS',
  'ANNOUNCEMENTS',
  'CERTIFICATES',
  'HALAQAT',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Ways a stored notification reaches a person.
 *
 *   IN_APP    kept in their notification center, counted in the badge — the
 *             record itself. Off means nothing is stored, so nothing below
 *             is delivered either.
 *   REALTIME  announced live to the app while it is connected.
 *   PUSH      sent to their registered devices, through a push provider.
 */
export const NOTIFICATION_CHANNELS = ['IN_APP', 'REALTIME', 'PUSH'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Where a device runs. */
export const DEVICE_PLATFORMS = ['IOS', 'ANDROID', 'WEB'] as const;

export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/**
 * Which service a device's token belongs to. APNs serves iOS only; FCM
 * serves every platform. No SDK for either is installed (see
 * docs/architecture/notifications.md, "Push").
 */
export const PUSH_PROVIDER_NAMES = ['APNS', 'FCM'] as const;

export type PushProviderName = (typeof PUSH_PROVIDER_NAMES)[number];

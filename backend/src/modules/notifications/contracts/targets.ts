/**
 * Where a notification leads: a typed reference to something in the
 * product, never a URL.
 *
 * A URL would let whatever created the notification send a person anywhere,
 * would bake one client's routes into stored rows, and would read like
 * permission to open what it points at. A target is only an address: the
 * client maps it to a screen, and that screen asks the owning module's API
 * for the content — with the same authorization as any other request. A
 * notification never grants access to anything; someone removed from a
 * conversation who taps an old notification about it is refused by
 * messaging, exactly as if they had typed its id.
 *
 * Every kind carries identifiers only. Clients degrade safely on a kind they
 * do not know (a newer server): the notification shows, and tapping it says
 * the content is not available in this version.
 *
 * Only `conversation` is created today; the others are reserved, with the
 * notification types that will use them.
 */
export type NotificationTarget =
  | { readonly kind: 'conversation'; readonly conversationId: string }
  | { readonly kind: 'assignment'; readonly assignmentId: string }
  | { readonly kind: 'announcement'; readonly announcementId: string }
  | { readonly kind: 'certificate'; readonly certificateId: string }
  | { readonly kind: 'halaqa'; readonly halaqaId: string }
  | { readonly kind: 'live_room'; readonly liveSessionId: string }
  /** The recipient's own profile — no identifier: it can only ever be theirs. */
  | { readonly kind: 'profile' };

export type NotificationTargetKind = NotificationTarget['kind'];

/** Each kind and the one identifier field it carries (none for `profile`). */
export const NOTIFICATION_TARGET_FIELDS: Readonly<Record<NotificationTargetKind, string | null>> =
  Object.freeze({
    conversation: 'conversationId',
    assignment: 'assignmentId',
    announcement: 'announcementId',
    certificate: 'certificateId',
    halaqa: 'halaqaId',
    live_room: 'liveSessionId',
    profile: null,
  });

/**
 * Values a notification's text may be filled with: names and codes, never
 * markup. Clients render every value as plain text.
 */
export type NotificationParams = Readonly<Record<string, string | number | boolean>>;

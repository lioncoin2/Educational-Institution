import type { NotificationTargetKind } from '../contracts/targets';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationType,
} from '../contracts/vocabulary';

export interface NotificationTypeDefinition {
  /** The preference that governs it. */
  readonly category: NotificationCategory;
  /**
   * Whether anything may create it today. A type becomes active when the
   * module whose fact it announces publishes that fact and a translator for
   * it exists — never before, so no notification describes something the
   * application does not actually do.
   */
  readonly active: boolean;
  /** Where it leads; a request with any other kind of target is refused. */
  readonly targetKind: NotificationTargetKind;
  /**
   * `false` for a type that never reaches a lock screen, whatever the person's
   * push preference: it is for people already in the app (ADR 0024). Absent,
   * push follows the category's preference.
   */
  readonly push?: false;
}

/**
 * Every notification type: its category, whether it is live, where it leads.
 * The single table the dispatcher and the preferences consult.
 */
export const NOTIFICATION_CATALOG: Readonly<Record<NotificationType, NotificationTypeDefinition>> =
  Object.freeze({
    MESSAGE_RECEIVED: { category: 'MESSAGES', active: true, targetKind: 'conversation' },
    CONVERSATION_CREATED: { category: 'MESSAGES', active: true, targetKind: 'conversation' },
    ADDED_TO_CONVERSATION: { category: 'MESSAGES', active: true, targetKind: 'conversation' },
    COMMUNITY_MEMBER_ADDED: { category: 'COMMUNITY', active: true, targetKind: 'community' },
    COMMUNITY_MEMBER_REMOVED: { category: 'COMMUNITY', active: true, targetKind: 'community' },
    COMMUNITY_CAPABILITY_GRANTED: { category: 'COMMUNITY', active: true, targetKind: 'community' },
    COMMUNITY_CAPABILITY_REVOKED: { category: 'COMMUNITY', active: true, targetKind: 'community' },
    COMMUNITY_OWNERSHIP_TRANSFERRED: {
      category: 'COMMUNITY',
      active: true,
      targetKind: 'community',
    },
    // A raised hand is for the moderators in the room: in-app and live only.
    LIVE_SPEAKER_REQUESTED: {
      category: 'LIVE',
      active: true,
      targetKind: 'live_room',
      push: false,
    },
    LIVE_SPEAKER_GRANTED: { category: 'LIVE', active: true, targetKind: 'live_room' },
    ATTENDANCE_SNAPSHOT_RECORDED: { category: 'ATTENDANCE', active: true, targetKind: 'live_room' },
    TASK_PUBLISHED: { category: 'TASKS', active: true, targetKind: 'assigned_task' },
    TASK_UPDATED: { category: 'TASKS', active: true, targetKind: 'assigned_task' },
    TASK_CANCELLED: { category: 'TASKS', active: true, targetKind: 'assigned_task' },
    TASK_REMINDER: { category: 'TASKS', active: true, targetKind: 'assigned_task' },
    TASK_REASSIGNED: { category: 'TASKS', active: true, targetKind: 'assigned_task' },
    TASK_ACKNOWLEDGED: { category: 'TASKS', active: true, targetKind: 'task' },
    TASK_COMPLETED: { category: 'TASKS', active: true, targetKind: 'task' },
    TASK_REPORT_SUBMITTED: { category: 'TASKS', active: true, targetKind: 'task' },
    TASK_REPORT_RESUBMITTED: { category: 'TASKS', active: true, targetKind: 'task' },
    TASK_REPORT_CHANGES_REQUESTED: { category: 'TASKS', active: true, targetKind: 'assigned_task' },
    TASK_REPORT_APPROVED: { category: 'TASKS', active: true, targetKind: 'assigned_task' },
    ASSIGNMENT_CREATED: { category: 'ASSIGNMENTS', active: false, targetKind: 'assignment' },
    ASSIGNMENT_UPDATED: { category: 'ASSIGNMENTS', active: false, targetKind: 'assignment' },
    ANNOUNCEMENT_CREATED: { category: 'ANNOUNCEMENTS', active: false, targetKind: 'announcement' },
    CERTIFICATE_ISSUED: { category: 'CERTIFICATES', active: false, targetKind: 'certificate' },
    HALAQA_UPDATE: { category: 'HALAQAT', active: false, targetKind: 'halaqa' },
  });

/**
 * Categories a person can set preferences for: those with at least one
 * active type. A switch for notifications that never arrive would be a lie.
 */
export const ACTIVE_CATEGORIES: readonly NotificationCategory[] = Object.freeze(
  NOTIFICATION_CATEGORIES.filter((category) =>
    Object.values(NOTIFICATION_CATALOG).some(
      (definition) => definition.active && definition.category === category,
    ),
  ),
);

export function isActiveCategory(value: string): value is NotificationCategory {
  return (ACTIVE_CATEGORIES as readonly string[]).includes(value);
}

/** Whether a type may be pushed at all (then the person's preference decides). */
export function mayPush(type: NotificationType): boolean {
  return NOTIFICATION_CATALOG[type].push !== false;
}

/**
 * Template keys. Every type owns the keys under `notification.<type>.`:
 *
 *   .title          the headline
 *   .body           the sentence, filled with the notification's params
 *   .body_private   the same fact with no names and no content — what a lock
 *                   screen shows (see `pushMessageFor`)
 */
export function templatePrefix(type: NotificationType): string {
  return `notification.${type.toLowerCase()}.`;
}

export function titleKeyOf(type: NotificationType): string {
  return `${templatePrefix(type)}title`;
}

export function bodyKeyOf(type: NotificationType): string {
  return `${templatePrefix(type)}body`;
}

export function privateBodyKeyOf(type: NotificationType): string {
  return `${templatePrefix(type)}body_private`;
}

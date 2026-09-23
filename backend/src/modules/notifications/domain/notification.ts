import type { Id } from '../../../shared/identifier';
import { err, failure, ok, type Result } from '../../../shared/result';
import {
  NOTIFICATION_TARGET_FIELDS,
  type NotificationParams,
  type NotificationTarget,
  type NotificationTargetKind,
} from '../contracts/targets';
import {
  NOTIFICATION_TYPES,
  type NotificationCategory,
  type NotificationType,
} from '../contracts/vocabulary';
import { NOTIFICATION_CATALOG, templatePrefix } from './catalog';
import { NotificationLimits } from './notification-policy';
import { isPlainText } from './text';

export type NotificationId = Id<'Notification'>;

/**
 * What a translator asks for: one notification, for one person.
 *
 * The dispatcher stores it at most once per `(recipientUserId, dedupeKey)` —
 * the key names the source fact and the recipient (for a new message,
 * `message:<messageId>:user:<userId>`), so the same fact delivered twice
 * becomes one notification however many times it arrives.
 */
export interface NotificationRequest {
  readonly recipientUserId: string;
  readonly type: NotificationType;
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly params: NotificationParams;
  readonly target: NotificationTarget;
  readonly dedupeKey: string;
}

/** A stored notification. Unread while `readAt` is null. */
export interface Notification {
  readonly id: NotificationId;
  readonly recipientUserId: string;
  readonly type: NotificationType;
  readonly category: NotificationCategory;
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly params: NotificationParams;
  readonly target: NotificationTarget;
  readonly dedupeKey: string;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

/** Account ids and the ids a target carries: opaque, short, URL-safe. */
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
/** `notification.<type>.<part>` — the templates a client ships. */
const TEMPLATE_KEY = /^notification\.[a-z0-9_]{1,40}\.[a-z0-9_]{1,40}$/;
const DEDUPE_KEY = /^[A-Za-z0-9_.:-]{1,200}$/;
const PARAM_NAME = /^[a-z][A-Za-z0-9]{0,39}$/;

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

const invalid = (field: string, message: string) =>
  err(failure('validation', 'notifications.request_invalid', message, { field }));

/**
 * The only way a notification comes to exist: every field checked, the
 * target and parameters COPIED field by field (nothing a request carries
 * beyond what is named here is ever stored), the category taken from the
 * catalog rather than trusted from the caller.
 */
export function createNotification(
  request: NotificationRequest,
  id: NotificationId,
  createdAt: Date,
): Result<Notification> {
  if (!isIdentifier(request.recipientUserId)) {
    return invalid('recipientUserId', 'A notification needs a recipient account.');
  }
  if (!isNotificationType(request.type)) {
    return invalid('type', 'Unknown notification type.');
  }
  const definition = NOTIFICATION_CATALOG[request.type];
  if (!definition.active) {
    return invalid('type', 'Nothing may create this notification type yet.');
  }
  const prefix = templatePrefix(request.type);
  for (const [field, key] of [
    ['titleKey', request.titleKey],
    ['bodyKey', request.bodyKey],
  ] as const) {
    if (typeof key !== 'string' || !TEMPLATE_KEY.test(key) || !key.startsWith(prefix)) {
      return invalid(field, `Template keys of ${request.type} start with "${prefix}".`);
    }
  }
  const target = parseTarget(request.target);
  if (target === null || target.kind !== definition.targetKind) {
    return invalid('target', `A ${request.type} notification leads to a ${definition.targetKind}.`);
  }
  const params = parseParams(request.params);
  if (params === null) {
    return invalid('params', 'Parameters are a few named values of plain text, numbers or flags.');
  }
  if (typeof request.dedupeKey !== 'string' || !DEDUPE_KEY.test(request.dedupeKey)) {
    return invalid('dedupeKey', 'A notification needs a deduplication key.');
  }
  return ok({
    id,
    recipientUserId: request.recipientUserId,
    type: request.type,
    category: definition.category,
    titleKey: request.titleKey,
    bodyKey: request.bodyKey,
    params,
    target,
    dedupeKey: request.dedupeKey,
    createdAt,
    readAt: null,
  });
}

/**
 * A target of a known kind with exactly its one identifier — a fresh object,
 * so nothing else the input carried survives. Null for anything else.
 * Also how stored targets are read back.
 */
export function parseTarget(value: unknown): NotificationTarget | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== 'string' || !Object.hasOwn(NOTIFICATION_TARGET_FIELDS, kind)) return null;
  const field = NOTIFICATION_TARGET_FIELDS[kind as NotificationTargetKind];
  const keys = Object.keys(record);
  if (field === null) return keys.length === 1 ? ({ kind } as NotificationTarget) : null;
  if (keys.length !== 2 || !isIdentifier(record[field])) return null;
  return { kind, [field]: record[field] } as NotificationTarget;
}

/**
 * Named values of plain text, finite numbers or booleans — at most a few,
 * each short. A fresh object; null for anything else, including nested
 * objects, arrays, markup-bearing control characters and prototype keys.
 */
export function parseParams(value: unknown): NotificationParams | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > NotificationLimits.maxParams) return null;
  const params: Record<string, string | number | boolean> = {};
  for (const [name, param] of entries) {
    if (!PARAM_NAME.test(name)) return null;
    if (typeof param === 'string') {
      if (!isPlainText(param, NotificationLimits.maxParamTextLength)) return null;
    } else if (typeof param === 'number') {
      if (!Number.isFinite(param)) return null;
    } else if (typeof param !== 'boolean') {
      return null;
    }
    params[name] = param;
  }
  return params;
}

export function isUnread(notification: Pick<Notification, 'readAt'>): boolean {
  return notification.readAt === null;
}

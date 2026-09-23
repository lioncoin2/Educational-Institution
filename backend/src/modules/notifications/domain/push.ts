import type { NotificationTarget } from '../contracts/targets';
import type { DevicePlatform, NotificationType, PushProviderName } from '../contracts/vocabulary';
import { privateBodyKeyOf, titleKeyOf } from './catalog';
import type { Notification } from './notification';

/** DI token. */
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

/** A device as a provider sees it: an address, and nothing about its owner. */
export interface PushDevice {
  readonly id: string;
  readonly platform: DevicePlatform;
  readonly provider: PushProviderName;
  readonly token: string;
}

/**
 * What a push says. Localization keys, not sentences — APNs (`title-loc-key`,
 * `loc-key`) and FCM (`title_loc_key`, `body_loc_key`) both render keys the
 * app ships, so the device shows it in the language it is set to.
 */
export interface PushMessage {
  readonly notificationId: string;
  readonly type: NotificationType;
  readonly titleKey: string;
  readonly bodyKey: string;
  /** Values for the body's placeholders, in order. Empty under the default policy. */
  readonly bodyArgs: readonly string[];
  /** Where a tap leads — the same typed target the app resolves in-app. */
  readonly target: NotificationTarget;
  /** Groups a burst on the device (APNs `thread-id`, FCM `tag`): one per conversation. */
  readonly threadKey: string;
}

/**
 * What became of one send, as the adapter classifies the provider's answer.
 * The classification is the adapter's job — only it knows that FCM's
 * `UNREGISTERED` or APNs' `410 Unregistered` mean "this token is gone".
 *
 *   delivered      accepted by the provider (which is all a server can know)
 *   retryable      a transient failure — throttling, a 5xx, a timeout
 *   invalid_token  the provider says the token will never work again
 *   rejected       a permanent failure for this message — retrying cannot help
 */
export type PushOutcome =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'retryable'; readonly reason: string; readonly retryAfterSeconds?: number }
  | { readonly kind: 'invalid_token'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * A push service, behind a port. The adapters live in infrastructure; no
 * vendor SDK is imported anywhere else (enforced by dependency-cruiser).
 * V1 ships a logging adapter only — see docs/architecture/notifications.md.
 */
export interface PushProvider {
  /**
   * Whether a device may be registered with this provider — the place an
   * adapter validates a token with its service, if it can. Asked before the
   * device is stored, so it knows the address, not a device id.
   */
  registerDevice(device: Omit<PushDevice, 'id'>): Promise<{ readonly accepted: boolean }>;
  /** A device was unregistered; an adapter that keeps provider-side state drops it. */
  unregisterDevice(device: PushDevice): Promise<void>;
  send(device: PushDevice, message: PushMessage): Promise<PushOutcome>;
}

/**
 * The lock-screen policy: what a push may say. PROVISIONAL (open-questions.md
 * Q24): until the institution decides otherwise, a push says only what KIND
 * of thing happened — "a new message" — with no sender name and no content.
 * A lock screen is read by whoever holds the phone, and many of these phones
 * belong to children or are shared. The notification itself, with the
 * sender's name, is in the app, behind sign-in.
 */
export function pushMessageFor(notification: Notification): PushMessage {
  return {
    notificationId: notification.id,
    type: notification.type,
    titleKey: titleKeyOf(notification.type),
    bodyKey: privateBodyKeyOf(notification.type),
    bodyArgs: [],
    target: notification.target,
    threadKey: threadKeyOf(notification.target),
  };
}

function threadKeyOf(target: NotificationTarget): string {
  switch (target.kind) {
    case 'conversation':
      return `conversation:${target.conversationId}`;
    case 'assignment':
      return `assignment:${target.assignmentId}`;
    case 'announcement':
      return `announcement:${target.announcementId}`;
    case 'certificate':
      return `certificate:${target.certificateId}`;
    case 'halaqa':
      return `halaqa:${target.halaqaId}`;
    case 'live_room':
      return `live_room:${target.liveSessionId}`;
    case 'profile':
      return 'profile';
  }
}

/**
 * Retries for a `retryable` outcome: a few, spaced out, then give up — the
 * notification is in the inbox whatever happens here. A provider's
 * `retryAfterSeconds` wins when it asks for longer; one that asks for longer
 * than `maxDelayMs` is not retried at all (see `retryDelayMs`).
 */
export const PushRetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 2000,
  maxDelayMs: 60_000,
});

/**
 * How long to wait before attempt `attempt + 1`: doubling up to
 * `maxDelayMs`, and never sooner than the provider asked.
 *
 * `null` means do not retry: the provider asked to wait longer than a retry
 * is ever held (`maxDelayMs`). Sending early would push into its throttle, and
 * holding a timer for an hour would keep a push that is stale by then — so the
 * push is given up, and the notification waits in the inbox. A `retryAfter`
 * that is not a positive number is an adapter's mistake and is ignored.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterSeconds?: number,
  policy: { readonly baseDelayMs: number; readonly maxDelayMs: number } = PushRetryPolicy,
): number | null {
  const backoff = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  if (retryAfterSeconds === undefined || !(retryAfterSeconds > 0)) return backoff;
  const asked = retryAfterSeconds * 1000;
  return asked > policy.maxDelayMs ? null : Math.max(backoff, asked);
}

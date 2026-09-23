import type { RateLimitPolicy } from '../../../shared';

/**
 * Device registrations per account. The app registers once each time it
 * starts signed in; thirty an hour is a reinstall loop, not a person.
 */
export const DEVICE_REGISTRATIONS_PER_USER: RateLimitPolicy = {
  name: 'notifications.device.register.user',
  limit: 30,
  windowSeconds: 3600,
};

/**
 * Audit actions. Ordinary notifications are NOT audited — they are the
 * inbox itself, and an audit row per message per recipient would bury the
 * log. What is audited is who can receive push on which device: a device
 * registered, moved from another account, unregistered, evicted by the
 * per-account limit, or switched off because its provider rejected it.
 * Tokens are never part of an entry.
 */
export const NotificationAuditActions = {
  deviceRegistered: 'notifications.device.registered',
  deviceUnregistered: 'notifications.device.unregistered',
  deviceEvicted: 'notifications.device.evicted',
  deviceDisabled: 'notifications.device.disabled',
} as const;

export const DEVICE_RESOURCE = 'notifications.device';

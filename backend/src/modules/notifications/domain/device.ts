import type { Id } from '../../../shared/identifier';
import { err, failure, ok, type Result } from '../../../shared/result';
import {
  DEVICE_PLATFORMS,
  PUSH_PROVIDER_NAMES,
  type DevicePlatform,
  type PushProviderName,
} from '../contracts/vocabulary';

export type DeviceId = Id<'NotificationDevice'>;

/**
 * An app installation that may receive push for one account.
 *
 * The token is the provider's address for the installation: needed to send,
 * and nothing more. It is not a credential — holding it grants nothing here,
 * and a push is never proof of who someone is — but it is still never
 * returned by the API, never logged, and never put in an event or an audit
 * entry. Whoever registers it last owns it: a token names an installation,
 * and an installation belongs to whoever is signed in on it now.
 */
export interface Device {
  readonly id: DeviceId;
  readonly userId: string;
  readonly platform: DevicePlatform;
  readonly provider: PushProviderName;
  readonly token: string;
  readonly createdAt: Date;
  /** Registered again (the app does so each time it starts signed in). */
  readonly lastSeenAt: Date;
  /** Set when the provider said the token is no longer valid. Push skips it. */
  readonly disabledAt: Date | null;
}

export interface DeviceRegistration {
  readonly platform: DevicePlatform;
  readonly provider: PushProviderName;
  readonly token: string;
}

/**
 * Token shapes, per provider. Loose on purpose — providers change lengths —
 * but enough to refuse what is certainly not a token: whitespace, markup,
 * or something the size of a document.
 *
 *   APNS  hexadecimal (the app sends the device token's bytes as hex); stored
 *         lower-case, so the same token never registers twice
 *   FCM   the registration token's alphabet: letters, digits and `_ - : .`
 */
const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
const FCM_TOKEN = /^[A-Za-z0-9_:.-]{32,1024}$/;

const refused = (field: string, message: string) =>
  err(failure('validation', 'notifications.device_invalid', message, { field }));

export function validateRegistration(input: {
  readonly platform: string;
  readonly provider: string;
  readonly token: string;
}): Result<DeviceRegistration> {
  if (!(DEVICE_PLATFORMS as readonly string[]).includes(input.platform)) {
    return refused('platform', 'Unknown device platform.');
  }
  if (!(PUSH_PROVIDER_NAMES as readonly string[]).includes(input.provider)) {
    return refused('provider', 'Unknown push provider.');
  }
  const platform = input.platform as DevicePlatform;
  const provider = input.provider as PushProviderName;
  if (provider === 'APNS' && platform !== 'IOS') {
    return refused('provider', 'APNs delivers to iOS devices only.');
  }
  const token = provider === 'APNS' ? input.token.toLowerCase() : input.token;
  const shape = provider === 'APNS' ? APNS_TOKEN : FCM_TOKEN;
  if (!shape.test(token)) {
    return refused('token', 'That is not a push token of this provider.');
  }
  return ok({ platform, provider, token });
}

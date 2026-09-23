import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_LOG,
  CLOCK,
  ID_GENERATOR,
  RATE_LIMITER,
  err,
  failure,
  ok,
  type AuditLog,
  type CallMetadata,
  type Clock,
  type IdGenerator,
  type Principal,
  type RateLimiter,
  type Result,
} from '../../../shared';
import { validateRegistration, type Device } from '../domain/device';
import { NotificationLimits } from '../domain/notification-policy';
import { DEVICE_REPOSITORY, type DeviceRepository } from '../domain/ports';
import { PUSH_PROVIDER, type PushDevice, type PushProvider } from '../domain/push';
import {
  DEVICE_REGISTRATIONS_PER_USER,
  DEVICE_RESOURCE,
  NotificationAuditActions,
} from './notification-settings';
import { toDeviceView, type DeviceView } from './views';

const pushDevice = (device: Device): PushDevice => ({
  id: device.id,
  platform: device.platform,
  provider: device.provider,
  token: device.token,
});

/**
 * Registers the signed-in person's own device for push — never anyone
 * else's: the account is the principal's, and a request cannot name another.
 *
 * Registering a token another account holds moves it here. A token is an app
 * installation's address, and the installation now belongs to whoever just
 * signed in on it — which is also what stops a shared classroom tablet from
 * showing the previous student's notifications. The move is audited, naming
 * the previous account; the token itself is never in the audit entry, a log
 * line or the response.
 *
 * Push is not authentication: a registered device proves nothing, and
 * nothing is ever granted to a request because a device is registered.
 */
@Injectable()
export class RegisterDeviceUseCase {
  constructor(
    @Inject(DEVICE_REPOSITORY) private readonly devices: DeviceRepository,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(input: {
    readonly principal: Principal;
    readonly platform: string;
    readonly provider: string;
    readonly token: string;
    readonly meta: CallMetadata;
  }): Promise<Result<DeviceView>> {
    const userId = input.principal.userId;
    const allowed = await this.limiter.consume(userId, DEVICE_REGISTRATIONS_PER_USER);
    if (!allowed.allowed) {
      return err(
        failure(
          'rate_limited',
          'notifications.too_many_registrations',
          'Too many device registrations. Try again later.',
          { retryAfterSeconds: allowed.retryAfterSeconds },
        ),
      );
    }
    const registration = validateRegistration(input);
    if (!registration.ok) return registration;

    const accepted = await this.provider.registerDevice(registration.value);
    if (!accepted.accepted) {
      return err(
        failure(
          'validation',
          'notifications.device_rejected',
          'The push provider does not accept this device.',
        ),
      );
    }

    const now = this.clock.now();
    const { device, previousUserId } = await this.devices.register({
      id: this.ids.next<'NotificationDevice'>(),
      userId,
      registration: registration.value,
      at: now,
    });
    await this.audit.record({
      actorUserId: userId,
      action: NotificationAuditActions.deviceRegistered,
      resourceType: DEVICE_RESOURCE,
      resourceId: device.id,
      at: now,
      correlationId: input.meta.correlationId,
      metadata: {
        platform: device.platform,
        provider: device.provider,
        ...(previousUserId === null ? {} : { movedFromUserId: previousUserId }),
      },
    });

    for (const evicted of await this.devices.trim(
      userId,
      NotificationLimits.maxActiveDevicesPerUser,
    )) {
      await this.provider.unregisterDevice(pushDevice(evicted));
      await this.audit.record({
        actorUserId: userId,
        action: NotificationAuditActions.deviceEvicted,
        resourceType: DEVICE_RESOURCE,
        resourceId: evicted.id,
        at: now,
        correlationId: input.meta.correlationId,
        metadata: { platform: evicted.platform, provider: evicted.provider },
      });
    }
    return ok(toDeviceView(device));
  }
}

/**
 * Forgets one of the signed-in person's devices — the app calls this on
 * sign-out, so a signed-out device stops receiving that account's push.
 * Another person's device is indistinguishable from one that does not exist.
 */
@Injectable()
export class UnregisterDeviceUseCase {
  constructor(
    @Inject(DEVICE_REPOSITORY) private readonly devices: DeviceRepository,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly principal: Principal;
    readonly deviceId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<void>> {
    const removed = await this.devices.remove(input.principal.userId, input.deviceId);
    if (removed === null) {
      return err(
        failure('not_found', 'notifications.device_not_found', 'There is no such device.'),
      );
    }
    await this.provider.unregisterDevice(pushDevice(removed));
    await this.audit.record({
      actorUserId: input.principal.userId,
      action: NotificationAuditActions.deviceUnregistered,
      resourceType: DEVICE_RESOURCE,
      resourceId: removed.id,
      at: this.clock.now(),
      correlationId: input.meta.correlationId,
      metadata: { platform: removed.platform, provider: removed.provider },
    });
    return ok(undefined);
  }
}

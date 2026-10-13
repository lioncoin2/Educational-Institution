import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { RequestMetadata } from '../../../platform/http/call-metadata.decorator';
import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import type { CallMetadata, Principal } from '../../../shared';
import { Authenticated } from '../../identity/contracts/route-access';
import {
  ListMutedConversationsUseCase,
  MuteConversationUseCase,
  UnmuteConversationUseCase,
} from '../application/conversation-mute.use-cases';
import { RegisterDeviceUseCase, UnregisterDeviceUseCase } from '../application/devices.use-cases';
import {
  CountUnreadNotificationsUseCase,
  ListNotificationsUseCase,
  MarkAllNotificationsReadUseCase,
  MarkNotificationReadUseCase,
} from '../application/inbox.use-cases';
import {
  GetNotificationPreferencesUseCase,
  UpdateNotificationPreferencesUseCase,
} from '../application/preferences.use-cases';
import {
  GetUserNotificationSettingsUseCase,
  UpdateUserNotificationSettingsUseCase,
} from '../application/user-notification-settings.use-cases';
import {
  ListNotificationsQuery,
  MarkAllReadDto,
  RegisterDeviceDto,
  UpdatePreferencesDto,
  UpdateUserNotificationSettingsDto,
} from './dto/notifications.dto';
import {
  toDeviceResponse,
  toMutedConversationsResponse,
  toNotificationResponse,
  toPreferencesResponse,
  toUnreadCountResponse,
  toUserNotificationSettingsResponse,
  type DeviceResponse,
  type MutedConversationsResponse,
  type NotificationResponse,
  type PreferencesResponse,
  type UserNotificationSettingsResponse,
} from './responses';

/**
 * The signed-in person's own notifications, preferences and push devices.
 *
 * Every route is `@Authenticated()` and nothing more, like managing one's own
 * sessions: having an inbox is inherent to having an account, and a role
 * that could not read its own notifications would make no sense. What keeps
 * this safe is scope, not a permission — every use case acts on the
 * principal's own id, no request can name another account, and another
 * person's notification or device answers 404 exactly like one that does not
 * exist.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly listNotifications: ListNotificationsUseCase,
    private readonly countUnread: CountUnreadNotificationsUseCase,
    private readonly markRead: MarkNotificationReadUseCase,
    private readonly markAllRead: MarkAllNotificationsReadUseCase,
    private readonly getPreferences: GetNotificationPreferencesUseCase,
    private readonly updatePreferences: UpdateNotificationPreferencesUseCase,
    private readonly getSettings: GetUserNotificationSettingsUseCase,
    private readonly updateSettings: UpdateUserNotificationSettingsUseCase,
    private readonly listMuted: ListMutedConversationsUseCase,
    private readonly muteConversation: MuteConversationUseCase,
    private readonly unmuteConversation: UnmuteConversationUseCase,
    private readonly registerDevice: RegisterDeviceUseCase,
    private readonly unregisterDevice: UnregisterDeviceUseCase,
  ) {}

  /** Newest first, a page at a time. */
  @Get()
  @Authenticated()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListNotificationsQuery,
  ): Promise<{ items: NotificationResponse[]; nextCursor: string | null }> {
    const page = unwrap(
      await this.listNotifications.execute({
        principal,
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
    return { items: page.items.map(toNotificationResponse), nextCursor: page.nextCursor };
  }

  /** `{ count, capped }` — counted up to 99; `capped` means "99+". */
  @Get('unread-count')
  @Authenticated()
  async unread(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ count: number; capped: boolean }> {
    return toUnreadCountResponse(unwrap(await this.countUnread.execute({ principal })));
  }

  /** Marks everything up to `throughId` (or until now) read. */
  @Post('read-all')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async readAll(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: MarkAllReadDto,
  ): Promise<{ markedRead: number; complete: boolean }> {
    return unwrap(await this.markAllRead.execute({ principal, throughId: dto.throughId }));
  }

  /** Idempotent. */
  @Post(':notificationId/read')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async read(
    @CurrentPrincipal() principal: Principal,
    @Param('notificationId') notificationId: string,
  ): Promise<NotificationResponse> {
    return toNotificationResponse(
      unwrap(await this.markRead.execute({ principal, notificationId })),
    );
  }

  @Get('preferences')
  @Authenticated()
  async preferences(@CurrentPrincipal() principal: Principal): Promise<PreferencesResponse> {
    return toPreferencesResponse(unwrap(await this.getPreferences.execute({ principal })));
  }

  @Patch('preferences')
  @Authenticated()
  async changePreferences(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: UpdatePreferencesDto,
  ): Promise<PreferencesResponse> {
    return toPreferencesResponse(
      unwrap(
        await this.updatePreferences.execute({
          principal,
          category: dto.category,
          inApp: dto.inApp,
          realtime: dto.realtime,
          push: dto.push,
        }),
      ),
    );
  }

  /** The caller's own timezone and quiet-hours choice. */
  @Get('settings')
  @Authenticated()
  async settings(
    @CurrentPrincipal() principal: Principal,
  ): Promise<UserNotificationSettingsResponse> {
    return toUserNotificationSettingsResponse(
      unwrap(await this.getSettings.execute({ principal })),
    );
  }

  /** Changes the caller's own timezone and/or quiet-hours choice. */
  @Patch('settings')
  @Authenticated()
  async changeSettings(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: UpdateUserNotificationSettingsDto,
  ): Promise<UserNotificationSettingsResponse> {
    return toUserNotificationSettingsResponse(
      unwrap(
        await this.updateSettings.execute({
          principal,
          timezone: dto.timezone,
          quietHoursMode: dto.quietHoursMode as 'INHERIT' | 'DISABLED' | 'CUSTOM' | undefined,
          quietHoursStart: dto.quietHoursStart,
          quietHoursEnd: dto.quietHoursEnd,
        }),
      ),
    );
  }

  /** The caller's own muted conversations, newest first. */
  @Get('mutes')
  @Authenticated()
  async mutes(@CurrentPrincipal() principal: Principal): Promise<MutedConversationsResponse> {
    return toMutedConversationsResponse(unwrap(await this.listMuted.execute({ principal })));
  }

  /** Mutes a conversation's push for the caller. Idempotent. */
  @Put('mutes/:conversationId')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async mute(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<{ conversationId: string; muted: boolean }> {
    return unwrap(await this.muteConversation.execute({ principal, conversationId }));
  }

  /** Unmutes a conversation for the caller. Idempotent. */
  @Delete('mutes/:conversationId')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async unmute(
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<{ conversationId: string; muted: boolean }> {
    return unwrap(await this.unmuteConversation.execute({ principal, conversationId }));
  }

  /** Registers (or refreshes) this device for the caller. The token is never echoed back. */
  @Post('devices')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async device(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: RegisterDeviceDto,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<DeviceResponse> {
    return toDeviceResponse(
      unwrap(
        await this.registerDevice.execute({
          principal,
          platform: dto.platform,
          provider: dto.provider,
          token: dto.token,
          meta,
        }),
      ),
    );
  }

  @Delete('devices/:deviceId')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async forgetDevice(
    @CurrentPrincipal() principal: Principal,
    @Param('deviceId') deviceId: string,
    @RequestMetadata() meta: CallMetadata,
  ): Promise<void> {
    unwrap(await this.unregisterDevice.execute({ principal, deviceId, meta }));
  }
}

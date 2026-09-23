import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConnectionManager } from './application/connection-manager';
import { MessagingRealtimeRelay } from './application/messaging-relay';
import { NotificationRealtimeRelay } from './application/notification-relay';
import { RealtimeSessions } from './application/realtime-sessions';
import { WebSocketTransport } from './infrastructure/websocket-transport';

/**
 * Realtime — messaging's and notifications' events, delivered to connected
 * clients while they are connected.
 *
 *   messaging (persist, publish)  →  event bus  →  MessagingRealtimeRelay
 *     → recipients (messaging's MESSAGE_RECIPIENTS, per event)
 *     → ConnectionManager (this instance's connections, per account)
 *     → WebSocketTransport → the client, which reconciles by sequence
 *
 *   notifications (persist, publish)  →  event bus  →  NotificationRealtimeRelay
 *     → the stored notification (NOTIFICATION_READER) → its recipient only
 *     → the same ConnectionManager, the same socket
 *
 * An extension of both, never a second messaging or notification system: it
 * stores nothing, decides no messaging or notification rule, and nothing
 * depends on it. When it is down, messages and notifications are still
 * stored and HTTP still serves them. It depends on identity's contracts
 * (authentication, the `messaging.read` check), messaging's (recipients,
 * delivery views, positions) and notifications' (the reader), and exports
 * nothing.
 */
@Module({
  imports: [IdentityModule, MessagingModule, NotificationsModule],
  providers: [
    ConnectionManager,
    RealtimeSessions,
    MessagingRealtimeRelay,
    NotificationRealtimeRelay,
    WebSocketTransport,
  ],
})
export class RealtimeModule {}

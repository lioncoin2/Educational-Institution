import { Module } from '@nestjs/common';

import { CommunitiesModule } from '../communities/communities.module';
import { IdentityModule } from '../identity/identity.module';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommunitiesRealtimeRelay } from './application/communities-relay';
import { ConnectionManager } from './application/connection-manager';
import { MessagingRealtimeRelay } from './application/messaging-relay';
import { NotificationRealtimeRelay } from './application/notification-relay';
import { RealtimeSessions } from './application/realtime-sessions';
import { WebSocketTransport } from './infrastructure/websocket-transport';

/**
 * Realtime — messaging's, notifications' and Communities' events, delivered
 * to connected clients while they are connected.
 *
 *   messaging (persist, publish)  →  event bus  →  MessagingRealtimeRelay
 *     → recipients (messaging's MESSAGE_RECIPIENTS, per event, asked only
 *       about the accounts connected here: onlineAudience)
 *     → ConnectionManager (this instance's connections, per account)
 *     → WebSocketTransport → the client, which reconciles by sequence
 *
 *   notifications (persist, publish)  →  event bus  →  NotificationRealtimeRelay
 *     → the stored notification (NOTIFICATION_READER) → its recipient only
 *     → the same ConnectionManager, the same socket
 *
 *   Communities (persist, publish)  →  event bus  →  CommunitiesRealtimeRelay
 *     → the person concerned, or the ACTIVE members connected here
 *       (COMMUNITY_MEMBERSHIP, per event), who may view the community
 *     → the same ConnectionManager, the same socket — a hint the client
 *       answers by re-reading the community over HTTP
 *
 * An extension of each, never a second messaging, notification or community
 * system: it stores nothing, decides no rule of theirs, and nothing depends
 * on it. When it is down, everything is still stored and HTTP still serves
 * it. It depends on identity's contracts (authentication, the `messaging.read`
 * check, the account directory), messaging's (recipients, delivery views,
 * positions), notifications' (the reader) and Communities' (membership facts,
 * the view ceiling, its events), and exports nothing.
 */
@Module({
  imports: [IdentityModule, MessagingModule, NotificationsModule, CommunitiesModule],
  providers: [
    ConnectionManager,
    RealtimeSessions,
    MessagingRealtimeRelay,
    NotificationRealtimeRelay,
    CommunitiesRealtimeRelay,
    WebSocketTransport,
  ],
})
export class RealtimeModule {}

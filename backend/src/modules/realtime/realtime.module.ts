import { Module } from '@nestjs/common';

import { CommunitiesModule } from '../communities/communities.module';
import { IdentityModule } from '../identity/identity.module';
import { LiveModule } from '../live/live.module';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommunitiesRealtimeRelay } from './application/communities-relay';
import { ConnectionManager } from './application/connection-manager';
import { LiveRealtimeRelay } from './application/live-relay';
import { MessagingRealtimeRelay } from './application/messaging-relay';
import { NotificationRealtimeRelay } from './application/notification-relay';
import { RealtimeSessions } from './application/realtime-sessions';
import { WebSocketTransport } from './infrastructure/websocket-transport';

/**
 * Realtime — messaging's, notifications', Communities' and Live's events,
 * delivered to connected clients while they are connected.
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
 *   Live (persist, publish)  →  event bus  →  LiveRealtimeRelay
 *     → a start or an end: the community's ACTIVE members connected here
 *       whom Live accepts as participants (LIVE_AUDIENCE, per event)
 *     → a hand, floor or screen change: the person it concerns at once, and
 *       the session's moderators connected here, coalesced per session
 *     → the same ConnectionManager, the same socket — a hint the client
 *       answers by re-reading the session over HTTP
 *
 * An extension of each, never a second messaging, notification, community
 * or live system: it stores nothing, decides no rule of theirs, and nothing
 * depends on it. When it is down, everything is still stored and HTTP still
 * serves it. It depends on identity's contracts (authentication, the `messaging.read`
 * check, the account directory), messaging's (recipients, delivery views,
 * positions), notifications' (the reader), Communities' (membership facts,
 * the view ceiling, its events) and Live's (its events, the audience of a
 * session's facts, the moderators' coalescing interval), and exports nothing.
 */
@Module({
  imports: [IdentityModule, MessagingModule, NotificationsModule, CommunitiesModule, LiveModule],
  providers: [
    ConnectionManager,
    RealtimeSessions,
    MessagingRealtimeRelay,
    NotificationRealtimeRelay,
    CommunitiesRealtimeRelay,
    LiveRealtimeRelay,
    WebSocketTransport,
  ],
})
export class RealtimeModule {}

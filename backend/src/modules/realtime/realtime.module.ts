import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { MessagingModule } from '../messaging/messaging.module';
import { ConnectionManager } from './application/connection-manager';
import { MessagingRealtimeRelay } from './application/messaging-relay';
import { RealtimeSessions } from './application/realtime-sessions';
import { WebSocketTransport } from './infrastructure/websocket-transport';

/**
 * Realtime — messaging's events, delivered to connected clients while they
 * are connected.
 *
 *   messaging (persist, publish)  →  event bus  →  MessagingRealtimeRelay
 *     → recipients (messaging's MESSAGE_RECIPIENTS, per event)
 *     → ConnectionManager (this instance's connections, per account)
 *     → WebSocketTransport → the client, which reconciles by sequence
 *
 * An extension of messaging, never a second messaging system: it stores
 * nothing, decides no messaging rule, and nothing depends on it. When it is
 * down, messages are still stored and HTTP still serves them; clients catch
 * up by sequence. It depends on identity's contracts (authentication, the
 * `messaging.read` check) and messaging's (recipients, delivery views,
 * positions), and exports nothing.
 */
@Module({
  imports: [IdentityModule, MessagingModule],
  providers: [ConnectionManager, RealtimeSessions, MessagingRealtimeRelay, WebSocketTransport],
})
export class RealtimeModule {}

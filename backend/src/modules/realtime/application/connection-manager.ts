import { Injectable } from '@nestjs/common';

import type { Connection } from '../domain/connection';
import { CloseCodes } from '../domain/protocol';

/**
 * The authenticated connections on THIS instance, by id and by account.
 *
 * Transport-agnostic: it holds `ClientLink`s, never sockets. One account may
 * hold several connections — a phone, a tablet, a browser — and everything
 * sent to the account goes to each of them.
 *
 * It answers "where is this person connected?", never "may they receive
 * this?": that is decided before anything is handed to it — membership by
 * messaging, per event; authentication by identity, per connection.
 *
 * Single-instance by design. With several API instances each keeps its own
 * connections, and every instance must see every event — a broker-backed
 * event bus, not a shared connection table (docs/architecture/realtime.md).
 */
@Injectable()
export class ConnectionManager {
  private readonly connections = new Map<string, Connection>();
  private readonly byUser = new Map<string, Set<string>>();

  register(connection: Connection): void {
    this.connections.set(connection.connectionId, connection);
    const ids = this.byUser.get(connection.userId) ?? new Set<string>();
    ids.add(connection.connectionId);
    this.byUser.set(connection.userId, ids);
  }

  /** Forgets a connection. The transport calls this once the socket is gone. */
  unregister(connectionId: string): Connection | undefined {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) return undefined;
    this.connections.delete(connectionId);
    const ids = this.byUser.get(connection.userId);
    ids?.delete(connectionId);
    if (ids?.size === 0) this.byUser.delete(connection.userId);
    return connection;
  }

  get(connectionId: string): Connection | undefined {
    return this.connections.get(connectionId);
  }

  getUserConnections(userId: string): readonly Connection[] {
    const ids = this.byUser.get(userId);
    if (ids === undefined) return [];
    return [...ids].flatMap((id) => {
      const connection = this.connections.get(id);
      return connection === undefined ? [] : [connection];
    });
  }

  isOnline(userId: string): boolean {
    return this.byUser.has(userId);
  }

  /**
   * Sends one frame to every connection of one account. Returns how many took
   * it. A connection that cannot — closed, too far behind, or failing — is
   * dropped, and never stops the others from receiving.
   */
  sendToUser(userId: string, frame: string): number {
    let delivered = 0;
    for (const connection of this.getUserConnections(userId)) {
      if (accepts(connection, frame)) {
        delivered += 1;
      } else {
        // Never leave a socket open that we have stopped delivering to: the
        // client would believe it is listening. Closed, it reconnects and
        // catches up.
        this.unregister(connection.connectionId);
        closeQuietly(connection);
      }
    }
    return delivered;
  }

  sendToUsers(userIds: Iterable<string>, frame: string): number {
    let delivered = 0;
    for (const userId of new Set(userIds)) delivered += this.sendToUser(userId, frame);
    return delivered;
  }

  /** Closes a connection with a reason and forgets it at once. */
  disconnect(connectionId: string, code: number, reason: string): void {
    const connection = this.unregister(connectionId);
    connection?.link.close(code, reason);
  }

  count(): number {
    return this.connections.size;
  }

  all(): readonly Connection[] {
    return [...this.connections.values()];
  }
}

function accepts(connection: Connection, frame: string): boolean {
  try {
    return connection.link.send(frame);
  } catch {
    return false;
  }
}

function closeQuietly(connection: Connection): void {
  try {
    connection.link.close(CloseCodes.serverError, 'delivery failed');
  } catch {
    // Already gone.
  }
}

import type { RateLimitPolicy } from '../../../shared/rate-limit';

/**
 * Realtime limits.
 *
 * PROVISIONAL — development-safe defaults chosen to be generous to honest
 * clients and cheap to enforce, not a measured production policy. They are
 * listed, with the reasoning for each, in docs/architecture/realtime.md §M8
 * and tracked as open question Q26. Changing one is a code change here, in
 * one place, reviewed like any other.
 */
export const RealtimeLimits = Object.freeze({
  /** A new connection has this long to authenticate before it is closed. */
  authDeadlineSeconds: 10,
  /** Concurrent authenticated connections per account: a phone, a tablet, a few browser tabs. */
  connectionsPerUser: 10,
  /**
   * The largest frame a client may send. The largest legitimate one is `auth`,
   * which carries a ~300-byte access token; anything near this is not a client
   * of ours. Enforced by the transport before a frame is buffered whole.
   */
  maxInboundFrameBytes: 4096,
  /**
   * The server pings every connection this often; one that has not answered
   * by the next ping is dead and is dropped. Clients ping the server at the
   * same interval, for the same reason in the other direction.
   */
  heartbeatSeconds: 25,
  /**
   * How often an authenticated connection's session, account and permissions
   * are re-checked while it stays open — the bound on how long a revoked
   * session or a suspended account can keep receiving.
   */
  revalidateSeconds: 60,
  /**
   * Outbound bytes a client may leave unread. A client this far behind is
   * disconnected; it reconnects and catches up over HTTP, which costs the
   * server nothing to hold.
   */
  maxBufferedBytes: 1024 * 1024,
  /** Connections one instance accepts at once. */
  maxConnections: 10_000,
  /** How often expiries, deadlines and revalidation are checked. */
  sweepSeconds: 5,
});

/**
 * WebSocket handshakes per client address. High on purpose: a whole school
 * reconnecting after a network blip arrives from one NAT address. This stops
 * a flood, not a classroom.
 */
export const HANDSHAKES_PER_ADDRESS: RateLimitPolicy = {
  name: 'realtime.handshake.address',
  limit: 300,
  windowSeconds: 60,
};

/** New authenticated connections per account — a client stuck in a reconnect loop. */
export const CONNECTIONS_OPENED_PER_USER: RateLimitPolicy = {
  name: 'realtime.connect.user',
  limit: 30,
  windowSeconds: 60,
};

/**
 * Frames per connection. An honest client sends a ping every 25 seconds and
 * a handful of subscriptions; sixty a minute is room to spare.
 */
export const FRAMES_PER_CONNECTION: RateLimitPolicy = {
  name: 'realtime.frames.connection',
  limit: 60,
  windowSeconds: 60,
};

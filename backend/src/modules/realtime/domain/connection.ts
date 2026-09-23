/**
 * The transport's handle on one connected client — all the application layer
 * ever sees of a socket. Implemented in infrastructure; nothing above it
 * knows which WebSocket library, or whether it is a WebSocket at all.
 */
export interface ClientLink {
  /**
   * Queues one text frame. False when the client can no longer take it —
   * already closed, or so far behind that the transport has let it go.
   */
  send(frame: string): boolean;

  /** Ends the connection with a close code (`CloseCodes`) and a short reason. */
  close(code: number, reason: string): void;
}

/**
 * What the server keeps about an authenticated connection. Deliberately
 * little: who, through which session, until when, and when it was last heard
 * from. No roles or permissions (they are re-read from identity), no
 * conversation membership (it is re-read from messaging for every event), no
 * message history (the database has it), no profile data.
 */
export interface Connection {
  readonly connectionId: string;
  readonly userId: string;
  /** The signed-in session it authenticated through — re-checked, and ended with it. */
  sessionId: string;
  readonly authenticatedAt: Date;
  /** When the credential it presented expires; re-authenticating moves it. */
  expiresAt: Date;
  /** When the session, account and permissions were last confirmed. */
  validatedAt: Date;
  /** The last frame or heartbeat reply. */
  lastSeenAt: Date;
  /** Transport metadata: where it connected from — for limits and logs, never for authorization. */
  readonly remoteAddress: string;
  readonly link: ClientLink;
}

/**
 * Notification limits. Chosen to be generous to honest use and cheap to
 * enforce; each is one constant, changed here and reviewed like any code.
 */
export const NotificationLimits = Object.freeze({
  /**
   * The badge counts up to this and then says "99+": counting stops at the
   * cap, so a backlog of 100,000 costs what a backlog of 100 does.
   */
  unreadCountCap: 99,
  /** Notifications per page of the inbox. */
  defaultPageSize: 20,
  maxPageSize: 50,
  /**
   * "Mark all as read" updates at most this many rows per statement, and
   * repeats until the boundary is reached — never one unbounded UPDATE.
   */
  markAllChunk: 1000,
  /** …and stops after this many statements; the rest waits for the next call. */
  markAllMaxChunks: 50,
  /** Requests per dispatch — one page of recipients. */
  maxRequestsPerDispatch: 1000,
  /** Parameters per notification, and the length of each text value. */
  maxParams: 10,
  maxParamTextLength: 200,
  /**
   * Devices that receive push for one account at once. Registering another
   * forgets the one seen least recently: a phone replaced three times over
   * should not keep receiving.
   */
  maxActiveDevicesPerUser: 10,
});

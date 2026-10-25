/** DI token. */
export const LIVE_CHAT = Symbol('LIVE_CHAT');

/** One message of a session's own chat, as every participant sees it (ADR 0047). */
export interface LiveChatMessageView {
  readonly id: string;
  readonly sessionId: string;
  readonly senderId: string;
  /** The sender's name from the account directory; '' when the account has none now. */
  readonly senderDisplayName: string;
  readonly body: string;
  readonly createdAt: Date;
  /** The session's chat order — increasing, gaps meaning nothing; the page keyset. */
  readonly position: number;
}

/**
 * LIVE_CHAT — a session's chat messages, for the module that DELIVERS them
 * (realtime). No principal: trusted in-process delivery code, which learns
 * ids from `live.chat.posted` and may hand the view only to those
 * LIVE_AUDIENCE.participantsAmong accepts for that session.
 */
export interface LiveChat {
  /** The message of this session, rendered; null when unknown or another session's. */
  forDelivery(sessionId: string, messageId: string): Promise<LiveChatMessageView | null>;
}

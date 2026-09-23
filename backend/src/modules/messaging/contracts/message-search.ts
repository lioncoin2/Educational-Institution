import type { Page, PageRequest } from '../../../shared/pagination';
import type { Principal } from '../../../shared/principal';
import type { Result } from '../../../shared/result';
import type { MessageType } from './vocabulary';

/**
 * EXTENSION POINT — not implemented in V1, and nothing provides it.
 *
 * Search is where "may read messages" most easily turns into "may read ALL
 * messages", so the contract fixes the rule before any engine exists:
 *
 *   An implementation returns only messages the searcher could open through
 *   the timeline right now — conversations they are a CURRENT member of,
 *   within their visibility window, never deleted content — and applies the
 *   same permission checks as reading. An index is a copy; it must not be a
 *   side door.
 *
 * A Postgres full-text implementation over `messages.body` fits V1 volumes;
 * a dedicated engine later would sit behind this same interface, fed from
 * `messaging.message.sent`. See docs/architecture/messaging.md.
 */
export interface MessageSearchQuery {
  readonly text: string;
  readonly conversationId?: string;
  readonly types?: readonly MessageType[];
  readonly page: PageRequest;
}

export interface MessageSearchHit {
  readonly conversationId: string;
  readonly messageId: string;
  readonly sequence: number;
  /** A short excerpt around the match — never the whole body. */
  readonly excerpt: string;
}

export interface MessageSearch {
  search(principal: Principal, query: MessageSearchQuery): Promise<Result<Page<MessageSearchHit>>>;
}

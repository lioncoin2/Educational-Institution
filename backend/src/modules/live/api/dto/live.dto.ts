import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import {
  HANDS_PAGE_MAX,
  HANDS_STATES,
  type HandsState,
} from '../../application/list-hands.use-case';
import { LIVE_CHAT_PAGE_MAX } from '../../application/live-chat.use-cases';

/**
 * Transport shapes for /live: the moderators' hands page's query, and the
 * session chat's page query and post (ADR 0047) — the one live body, which
 * carries the poster's text and their idempotency key, nothing more. Who the
 * caller is, which hand is theirs, what they may publish and what they are
 * called are the server's to know, never a claim in a request. Unknown
 * fields are refused (400) by the global pipe.
 */
export class HandsQuery {
  /** The queue (`pending`, when absent) or who holds the floor (`granted`). */
  @IsOptional()
  @IsIn(HANDS_STATES)
  state?: HandsState;

  /** Opaque; one this API did not issue is 422 `live.cursor_invalid`. */
  @IsOptional()
  @IsString()
  cursor?: string;

  /** 1 to HANDS_PAGE_MAX, else 400; the use case's default page when absent. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(HANDS_PAGE_MAX)
  limit?: number;
}

/** A session chat page (ADR 0047): older than `before`, newest first. */
export class LiveChatQuery {
  /** A position from a previous page's `nextCursor`; one this API did not issue is 422. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIVE_CHAT_PAGE_MAX)
  limit?: number;
}

/** A post to a session's chat: the text, and the client's key that makes a retry land once. */
export class PostLiveChatDto {
  @IsString()
  @MaxLength(128)
  clientMessageId!: string;

  /** Bounded here as an abuse cap; the domain's limit (500 characters) answers 422 precisely. */
  @IsString()
  @MaxLength(4000)
  body!: string;
}

/** A reaction in a running session (ADR 0049): the kind alone; the domain names the four. */
export class SendLiveReactionDto {
  @IsString()
  @MaxLength(32)
  kind!: string;
}

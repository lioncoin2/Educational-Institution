import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

import {
  HANDS_PAGE_MAX,
  HANDS_STATES,
  type HandsState,
} from '../../application/list-hands.use-case';

/**
 * Transport shapes for /live. There is exactly one, the moderators' hands
 * page's query: no live route takes a body. Who the caller is, which hand is
 * theirs, what they may publish and what they are called are the server's to
 * know, never a claim in a request. Unknown query fields are refused (400) by
 * the global pipe.
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

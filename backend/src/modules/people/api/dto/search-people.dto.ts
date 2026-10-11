import { Transform, Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `GET /people?q=&limit=&cursor=` query (the communities `PageQuery` house
 * style). `q` is the required display-name prefix: trimmed, non-empty (a blank
 * or whitespace-only term is 400 at the pipe), at most 100 characters. `limit`
 * is an optional integer — an oversize value is **clamped** to 200 in identity,
 * never refused, so there is no `@Max`; a non-integer is 400. `cursor` is any
 * string; a decode failure reads as the first page, not 400. Unknown query
 * fields are 400 (the global whitelist pipe).
 */
export class SearchPeopleQuery {
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(100)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}

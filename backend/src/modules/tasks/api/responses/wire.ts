/** Wire conventions of the tasks API: ISO-8601 instants, explicit nulls, names resolved at view time. */
export const iso = (date: Date): string => date.toISOString();
export const isoOrNull = (date: Date | null): string | null =>
  date === null ? null : date.toISOString();

/** A person as shown: their id, and their name when the account still exists. */
export interface PersonRef {
  readonly id: string;
  readonly name: string | null;
}

export function person(id: string, names: ReadonlyMap<string, string>): PersonRef {
  return { id, name: names.get(id) ?? null };
}

export function personOrNull(
  id: string | null,
  names: ReadonlyMap<string, string>,
): PersonRef | null {
  return id === null ? null : person(id, names);
}

export interface PageResponse<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

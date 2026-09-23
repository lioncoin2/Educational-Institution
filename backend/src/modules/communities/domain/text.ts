import { err, failure, ok, type Result } from '../../../shared/result';

/** A technical bound matching messaging's group titles — not a policy. */
export const TITLE_MAX_LENGTH = 100;

/**
 * Control characters, line separators, and the Unicode direction overrides
 * and isolates — which reorder text (`gpj.exe` read as `exe.jpg`, an Arabic
 * name shown backwards). Refused outright, not stripped, so the person typing
 * knows their text was not accepted as typed. Ordinary direction marks
 * (U+200E, U+200F) are allowed: Arabic text needs them.
 */
const FORBIDDEN_IN_TITLES = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

const invalid = (reason: string, message: string) =>
  err(failure('validation', 'communities.title_invalid', message, { field: 'title', reason }));

/** A community's title: trimmed, 1–100 characters of plain text. */
export function normalizeTitle(raw: string): Result<string> {
  if (FORBIDDEN_IN_TITLES.test(raw)) {
    return invalid('characters', 'A title may not contain control or direction characters.');
  }
  const title = raw.trim();
  if (title.length === 0) return invalid('empty', 'A title is required.');
  // Counted in code points, as Postgres' char_length counts them.
  if ([...title].length > TITLE_MAX_LENGTH) {
    return invalid('length', `A title is at most ${TITLE_MAX_LENGTH} characters.`);
  }
  return ok(title);
}

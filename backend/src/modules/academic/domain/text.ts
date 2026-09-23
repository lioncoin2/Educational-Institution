import { err, failure, ok, type Result } from '../../../shared/result';

/**
 * What an academic code, name or description may be.
 *
 * Codes are identifiers other systems and URLs use (`dep-literacy`,
 * `dep-literacy-h3`): lower-case letters, digits and single hyphens. They are
 * chosen by whoever creates the entity — never derived from a display name —
 * and never change afterwards.
 *
 * Names and descriptions are shown to every member of the institution, so
 * they are plain text: control characters, line separators and the Unicode
 * direction overrides and isolates (which make `gpj.exe` read as `exe.jpg`,
 * or reorder an Arabic name) are refused outright, not silently stripped —
 * the person typing should know their text was not accepted as typed.
 */
export const CODE_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const TextLimits = Object.freeze({
  codeMin: 2,
  codeMax: 64,
  nameMax: 120,
  descriptionMax: 2000,
  orderMax: 10_000,
});

const FORBIDDEN_IN_NAMES = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

/** Descriptions may break lines (\n); nothing else from the set above. */
const FORBIDDEN_IN_DESCRIPTIONS =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

function invalid(field: string, reason: string, message: string) {
  return err(failure('validation', `academic.${field}_invalid`, message, { field, reason }));
}

function length(value: string): number {
  return [...value].length;
}

/** Trimmed and lower-cased, then held to the code shape. */
export function normalizeCode(raw: string): Result<string> {
  const code = raw.trim().toLowerCase();
  if (length(code) < TextLimits.codeMin || length(code) > TextLimits.codeMax) {
    return invalid(
      'code',
      'length',
      `A code is ${TextLimits.codeMin} to ${TextLimits.codeMax} characters.`,
    );
  }
  if (!CODE_SHAPE.test(code)) {
    return invalid(
      'code',
      'shape',
      'A code uses lower-case letters, digits and single hyphens, e.g. "tajweed-2".',
    );
  }
  return ok(code);
}

/** Trimmed, inner whitespace collapsed; 1–120 characters of plain text. */
export function normalizeName(raw: string): Result<string> {
  if (FORBIDDEN_IN_NAMES.test(raw)) {
    return invalid('name', 'characters', 'A name may not contain control or direction characters.');
  }
  const name = raw.trim().replace(/\s+/gu, ' ');
  if (name.length === 0) return invalid('name', 'empty', 'A name is required.');
  if (length(name) > TextLimits.nameMax) {
    return invalid('name', 'length', `A name is at most ${TextLimits.nameMax} characters.`);
  }
  return ok(name);
}

/** Absent or blank means none. Line breaks are kept (as \n); at most 2000 characters. */
export function normalizeDescription(raw: string | null | undefined): Result<string | null> {
  if (raw === null || raw === undefined) return ok(null);
  const text = raw.replace(/\r\n?/gu, '\n');
  if (FORBIDDEN_IN_DESCRIPTIONS.test(text)) {
    return invalid(
      'description',
      'characters',
      'A description may not contain control or direction characters.',
    );
  }
  const description = text.trim();
  if (description.length === 0) return ok(null);
  if (length(description) > TextLimits.descriptionMax) {
    return invalid(
      'description',
      'length',
      `A description is at most ${TextLimits.descriptionMax} characters.`,
    );
  }
  return ok(description);
}

/** A display position: a whole number from 1. Positions may repeat; ties sort by code. */
export function validateOrder(value: number): Result<number> {
  if (!Number.isInteger(value) || value < 1 || value > TextLimits.orderMax) {
    return invalid(
      'order',
      'range',
      `An order is a whole number from 1 to ${TextLimits.orderMax}.`,
    );
  }
  return ok(value);
}

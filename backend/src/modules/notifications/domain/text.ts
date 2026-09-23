/**
 * Plain text for notification parameters: what may fill a template.
 *
 * A parameter is shown to a person as text, next to trusted wording, on a
 * notification list and one day on a lock screen. So it holds no control
 * characters, no line breaks, and no Unicode direction overrides or isolates
 * — the characters that make "gpj.exe" display as "exe.jpg", or push the
 * rest of a right-to-left sentence around. Ordinary marks of Arabic text
 * (the left-to-right and right-to-left MARKS) are kept.
 */
const DISALLOWED = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/**
 * `value` made safe to show, at most `maxLength` characters (whole code
 * points, so an Arabic letter or an emoji is never cut in half).
 */
export function plainText(value: string, maxLength: number): string {
  const cleaned = value.replace(DISALLOWED, ' ').replace(/\s+/gu, ' ').trim();
  const codePoints = Array.from(cleaned);
  return codePoints.length <= maxLength ? cleaned : codePoints.slice(0, maxLength).join('').trim();
}

/** Whether `value` is already exactly what `plainText` would make of it. */
export function isPlainText(value: string, maxLength: number): boolean {
  return value.length > 0 && plainText(value, maxLength) === value;
}

/**
 * P8.2 — secret redaction. The off-box generator reads credentials from the
 * environment (API key/secret, passwords, bearer/JWT tokens). Nothing may print
 * them — not in the preflight table, not in logs, not in error messages. These
 * helpers are the single place that knows how to mask them. Pure.
 */

/** A JWT (three base64url segments) — the shape of a LiveKit/access token. */
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;

/** key=value / key: value pairs whose key names a secret. */
const SECRET_KV =
  /\b(api[_-]?secret|api[_-]?key|secret|password|passwd|pwd|token|authorization|bearer)\b(\s*[:=]\s*)(\S+)/gi;

/** Masks a single value, keeping only a short tail hint for correlation. */
export function mask(value: string): string {
  if (value.length <= 4) return '****';
  return `****${value.slice(-4)}`;
}

/** Redacts JWTs and secret key/value pairs anywhere in a string. */
export function redact(text: string): string {
  return text
    .replace(SECRET_KV, (_m, key: string, sep: string, val: string) => `${key}${sep}${mask(val)}`)
    .replace(JWT, (m) => mask(m));
}

/** Redacts a value that IS a secret (whole thing), for deliberate display. */
export function redactSecret(value: string | undefined): string {
  if (!value) return '(unset)';
  return mask(value);
}

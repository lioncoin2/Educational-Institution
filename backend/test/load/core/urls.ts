/**
 * P8.2 — external target URL validation. The off-box generator must speak only
 * to the public test interfaces over TLS, and must NOT silently point at the
 * machine it runs on. These helpers validate the shapes and flag local targets
 * (a sign the generator is accidentally co-located with the system under test).
 * Pure.
 */

export interface UrlCheck {
  readonly ok: boolean;
  readonly host: string | null;
  readonly problems: readonly string[];
  /** True when the host is loopback/private — off-box runs should not target these. */
  readonly isLocal: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function isPrivateHost(host: string): boolean {
  if (LOCAL_HOSTS.has(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.endsWith('.local')) return true;
  return false;
}

/** Validates an HTTPS API base URL. */
export function checkHttpsUrl(raw: string | null | undefined): UrlCheck {
  return check(raw, ['https:'], 'https://');
}

/** Validates a WSS LiveKit URL. */
export function checkWssUrl(raw: string | null | undefined): UrlCheck {
  return check(raw, ['wss:'], 'wss://');
}

function check(raw: string | null | undefined, schemes: string[], hint: string): UrlCheck {
  const problems: string[] = [];
  if (!raw)
    return { ok: false, host: null, problems: [`missing (expected ${hint}…)`], isLocal: false };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      host: null,
      problems: [`not a valid URL (expected ${hint}…)`],
      isLocal: false,
    };
  }
  if (!schemes.includes(url.protocol))
    problems.push(`scheme must be ${schemes.join('/')} (got ${url.protocol})`);
  if (url.hostname === '') problems.push('no host');
  const isLocal = isPrivateHost(url.hostname);
  return { ok: problems.length === 0, host: url.hostname || null, problems, isLocal };
}

/** Derives the LiveKit server API (http) URL from a wss client URL. */
export function livekitApiUrl(wssUrl: string): string {
  return wssUrl.replace(/^ws/, 'http');
}

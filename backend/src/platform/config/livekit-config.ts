/**
 * Which LiveKit server a deployment talks to, and where (P7.1, decisions 1
 * and 3). `loadConfig` reads these settings; it checks the credentials
 * itself, beside the secrets they must never equal.
 *
 * Two paths reach the server, so there are two URLs:
 *
 *   LIVEKIT_URL      client → LiveKit: the signalling URL a join ticket
 *                    carries. ws: or wss:, and wss: only in a deployed
 *                    environment, real media enabled or not — a client never
 *                    connects in clear there — to a host clients can reach:
 *                    never an internal one there (P7.2).
 *   LIVEKIT_API_URL  API → LiveKit: the server API the adapter calls (the
 *                    room service and the readiness probe), e.g.
 *                    http://livekit:7880 over a private network. Optional:
 *                    derived from LIVEKIT_URL when unset (ws→http,
 *                    wss→https). http: or https:, and https: in a deployed
 *                    environment unless its host is internal, so the admin
 *                    token every server call carries never crosses a public
 *                    network in clear.
 *
 * LiveKit never terminates TLS itself (its port 7880 is plain HTTP): `wss:`
 * and `https:` name the deployment's TLS terminator in front of it.
 */

/**
 * The LiveKit server release this code is built and tested against — no
 * silent upgrade. With real media enabled the application refuses to boot
 * unless LIVEKIT_VERSION says exactly this; the deployment files and the
 * real-server suite read the same constant.
 */
export const PINNED_LIVEKIT_SERVER_VERSION = '1.13.7';

/** Why a URL cannot serve: it is not a URL of the right kind, or not secure enough here. */
export type UrlFault = 'malformed' | 'insecure';

export interface LiveKitServerSettings {
  readonly url: string;
  readonly apiUrl: string;
  /** LIVEKIT_VERSION as given; null when unset. */
  readonly version: string | null;
}

/** Where a local LiveKit listens when nothing else is said — development only. */
const LOCAL_DEVELOPMENT_URL = 'ws://localhost:7880';

/**
 * Reads LIVEKIT_URL, LIVEKIT_API_URL and LIVEKIT_VERSION, adding a problem
 * for each rule broken. `enabled`: LIVE_MEDIA_PROVIDER=livekit; `deployed`:
 * staging or production, named by `environment`.
 */
export function readLiveKitServer(
  env: NodeJS.ProcessEnv,
  context: { readonly enabled: boolean; readonly deployed: boolean; readonly environment: string },
  problems: string[],
): LiveKitServerSettings {
  const { enabled, deployed, environment } = context;

  const givenUrl = given(env.LIVEKIT_URL);
  if (givenUrl === null) {
    // A deployed environment needs every setting; real media needs this one anywhere.
    if (deployed) problems.push(`LIVEKIT_URL is required in ${environment}`);
    else if (enabled) problems.push('LIVEKIT_URL is required when LIVE_MEDIA_PROVIDER=livekit');
  } else {
    // Set without real media, it must still be a signalling URL — and a
    // secure one in a deployed environment, whatever the provider.
    const fault = clientUrlFault(givenUrl, deployed);
    if (fault === 'malformed') problems.push('LIVEKIT_URL must be a ws:// or wss:// URL');
    if (fault === 'insecure') {
      problems.push(
        `LIVEKIT_URL must use wss:// in ${environment}: clients never connect in clear`,
      );
    }
    // Every join ticket hands this URL to clients (P7.2, audit §4.7): in a
    // deployed environment it names a host they can reach, never one of this
    // deployment's internal ones.
    if (deployed && fault !== 'malformed' && isInternalHost(new URL(givenUrl).hostname)) {
      problems.push(
        `LIVEKIT_URL must name a public host in ${environment}, not an internal one ` +
          '(loopback, a single-label service name or a private IPv4 address): every join ' +
          'ticket hands it to clients',
      );
    }
  }
  const url = givenUrl ?? LOCAL_DEVELOPMENT_URL;

  const givenApiUrl = given(env.LIVEKIT_API_URL);
  if (givenApiUrl !== null) {
    const fault = apiUrlFault(givenApiUrl, deployed);
    if (fault === 'malformed') problems.push('LIVEKIT_API_URL must be an http:// or https:// URL');
    if (fault === 'insecure') {
      problems.push(
        `LIVEKIT_API_URL must use https:// in ${environment} unless its host is internal ` +
          '(loopback, a single-label service name or a private IPv4 address)',
      );
    }
  }

  const version = given(env.LIVEKIT_VERSION);
  if (enabled && version !== PINNED_LIVEKIT_SERVER_VERSION) {
    problems.push(
      `LIVEKIT_VERSION must be ${PINNED_LIVEKIT_SERVER_VERSION}, the pinned LiveKit server, ` +
        'when LIVE_MEDIA_PROVIDER=livekit',
    );
  }

  // Derived from a valid client URL, the API URL is as secure as it: https:
  // wherever real media needs wss:.
  return { url, apiUrl: givenApiUrl ?? apiUrlFor(url), version };
}

/**
 * Why `raw` cannot be the client-facing URL, or null when it can: a ws: or
 * wss: URL, and wss: when `requireSecure`.
 */
export function clientUrlFault(raw: string, requireSecure: boolean): UrlFault | null {
  const url = parse(raw);
  if (url === null || (url.protocol !== 'ws:' && url.protocol !== 'wss:')) return 'malformed';
  return requireSecure && url.protocol !== 'wss:' ? 'insecure' : null;
}

/**
 * Why `raw` cannot be the server-side API URL, or null when it can: an http:
 * or https: URL, and https: when `requireSecure` unless the host is internal.
 */
export function apiUrlFault(raw: string, requireSecure: boolean): UrlFault | null {
  const url = parse(raw);
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) return 'malformed';
  if (!requireSecure || url.protocol === 'https:') return null;
  return isInternalHost(url.hostname) ? null : 'insecure';
}

/** The API URL a client URL implies: the same host, over http(s). */
export function apiUrlFor(clientUrl: string): string {
  return clientUrl.replace(/^wss?:/i, (scheme) =>
    scheme.toLowerCase() === 'wss:' ? 'https:' : 'http:',
  );
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * A host reached without crossing a public network: loopback (`localhost`,
 * 127.0.0.0/8, `::1`), a single-label name — a container service name such
 * as `livekit` — or an RFC 1918 IPv4 literal (10/8, 172.16/12, 192.168/16).
 * `hostname` is a URL's, which is lower-cased, with IPv4 normalized and
 * IPv6 in brackets.
 */
export function isInternalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const octets = IPV4.exec(hostname);
  if (octets !== null) {
    const [first, second] = [Number(octets[1]), Number(octets[2])];
    return (
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  return hostname.length > 0 && !hostname.includes('.') && !hostname.startsWith('[');
}

/** A setting's value, trimmed; null when unset or blank. */
function given(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  return value === '' ? null : value;
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

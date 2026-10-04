/**
 * P8.4 — the SUT-side credential reader (design §2, §19). The controller runs on
 * the SUT, the credential authority. It reads ONLY `LIVEKIT_API_KEY` and
 * `LIVEKIT_API_SECRET` from the deployment env file into a local object — never
 * into `process.env` (so no child can inherit them), never logged — and pins
 * RoomService to loopback, whatever any variable says. The file's other
 * secrets (database, Redis, JWT, storage) are never parsed.
 */
import { readFile } from 'node:fs/promises';

import { type LivekitEnv } from './tokens';

/** The controller's RoomService endpoint: loopback only, never the public vhost. */
export const LOOPBACK_ROOM_SERVICE = 'http://127.0.0.1:7880';

const KEY = /^\s*(?:export\s+)?LIVEKIT_API_KEY\s*=\s*(.*)$/;
const SECRET = /^\s*(?:export\s+)?LIVEKIT_API_SECRET\s*=\s*(.*)$/;

function unquote(raw: string): string {
  const v = raw.trim();
  const quoted = /^(['"])(.*)\1$/.exec(v);
  return quoted ? (quoted[2] ?? '') : v;
}

/** The two LiveKit keys from env-file text, or null if either is missing. Pure. */
export function parseLivekitKeys(text: string): { apiKey: string; apiSecret: string } | null {
  let apiKey = '';
  let apiSecret = '';
  for (const line of text.split(/\r?\n/)) {
    const k = KEY.exec(line);
    if (k) apiKey = unquote(k[1] ?? '');
    const s = SECRET.exec(line);
    if (s) apiSecret = unquote(s[1] ?? '');
  }
  return apiKey && apiSecret ? { apiKey, apiSecret } : null;
}

/**
 * The controller's LiveKit env: client URL as given (what generators dial), keys
 * from `envFile`, RoomService on loopback. Throws without naming any value.
 */
export async function readFleetEnv(envFile: string, clientUrl: string): Promise<LivekitEnv> {
  const keys = parseLivekitKeys(await readFile(envFile, 'utf8'));
  if (!keys) throw new Error(`LIVEKIT_API_KEY / LIVEKIT_API_SECRET not found in ${envFile}`);
  return { url: clientUrl, apiUrl: LOOPBACK_ROOM_SERVICE, ...keys };
}

/**
 * P8 load harness — SFU-direct LiveKit access. For pure media-capacity tests the
 * harness mints LiveKit tokens itself and creates rooms with a NON-application
 * prefix, so it never touches the app's Postgres rows, never trips the 300-seat
 * app cap, and never collides with the reconciler (P8 plan §13, F7).
 *
 * This file names `livekit-server-sdk` (permitted under test/; the src-only
 * dependency-cruiser rule does not apply here) but NOT `@livekit/rtc-node` —
 * the WebRTC client stays under test/livekit/ per the architecture test.
 *
 * Secrets are read from the environment only (LOADTEST_LIVEKIT_*). Nothing here
 * is hardcoded and nothing is logged.
 */
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

import { type Role } from '../core/identity';

export interface LivekitEnv {
  /** Client-facing signalling URL, e.g. wss://livekit-staging.adlink4.com. */
  readonly url: string;
  /** Server API URL for RoomService (http(s)); defaults to `url` with ws→http. */
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

export interface MediaTicket {
  readonly url: string;
  readonly token: string;
}

/**
 * Reads LOADTEST_LIVEKIT_URL / _API_KEY / _API_SECRET (and optional _API_URL)
 * from the environment. Returns null when any are missing, so a dry-run needs no
 * credentials. Never throws, never logs secrets.
 */
export function loadLivekitEnv(env: NodeJS.ProcessEnv = process.env): LivekitEnv | null {
  const url = env.LOADTEST_LIVEKIT_URL;
  const apiKey = env.LOADTEST_LIVEKIT_API_KEY;
  const apiSecret = env.LOADTEST_LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) return null;
  const apiUrl = env.LOADTEST_LIVEKIT_API_URL ?? url.replace(/^ws/, 'http');
  return { url, apiUrl, apiKey, apiSecret };
}

function sourcesFor(role: Role): TrackSource[] {
  if (role === 'speaker') return [TrackSource.MICROPHONE];
  if (role === 'screen') return [TrackSource.SCREEN_SHARE];
  return [];
}

/**
 * Mints a short-lived join ticket for one synthetic participant. Listeners get
 * subscribe-only; speakers/screen publishers get exactly their one source.
 */
export async function mintTicket(
  env: LivekitEnv,
  params: { identity: string; room: string; role: Role; ttlSeconds?: number },
): Promise<MediaTicket> {
  const token = new AccessToken(env.apiKey, env.apiSecret, {
    identity: params.identity,
    ttl: params.ttlSeconds ?? 600,
  });
  const canPublish = params.role !== 'listener';
  token.addGrant({
    roomJoin: true,
    room: params.room,
    canSubscribe: true,
    canPublish,
    canPublishSources: sourcesFor(params.role),
    canPublishData: false,
  });
  return { url: env.url, token: await token.toJwt() };
}

/** A RoomServiceClient bound to the load env (server-side control plane). */
export function roomService(env: LivekitEnv): RoomServiceClient {
  return new RoomServiceClient(env.apiUrl, env.apiKey, env.apiSecret);
}

/** Creates (idempotently) the load rooms, with a short empty-timeout for self-cleanup. */
export async function ensureRooms(
  env: LivekitEnv,
  rooms: readonly string[],
  emptyTimeoutSeconds = 120,
): Promise<void> {
  const svc = roomService(env);
  for (const name of rooms) {
    await svc.createRoom({ name, emptyTimeout: emptyTimeoutSeconds }).catch(() => undefined);
  }
}

/** Deletes the load rooms — the cleanup step for SFU-direct runs. */
export async function deleteRooms(env: LivekitEnv, rooms: readonly string[]): Promise<void> {
  const svc = roomService(env);
  for (const name of rooms) {
    await svc.deleteRoom(name).catch(() => undefined);
  }
}

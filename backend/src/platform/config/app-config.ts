/**
 * The single place that reads `process.env`.
 *
 * Every setting is declared, validated and frozen here, so no module ever reads
 * undeclared configuration and a misconfigured deployment fails at boot rather
 * than at the first request. Secrets are values, never logged (see the redaction
 * list in `platform/logging`).
 */

import { readLiveKitServer } from './livekit-config';

export type NodeEnv = 'development' | 'test' | 'trial' | 'staging' | 'production';

const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'trial', 'staging', 'production'];

/**
 * Trial, staging and production are DEPLOYED environments: reachable by real
 * people, so each gets the production-grade checks — every secret supplied on
 * purpose, no placeholder, a minimum length, secrets kept apart, the database,
 * Redis and proxy settings named rather than defaulted, secure media URLs.
 * Development and test run with local defaults.
 *
 * Trial is the internet-facing evaluation environment (ADR 0037): the same
 * security baseline as staging, but it may run without a media server by
 * declaring `LIVE_MEDIA_PROVIDER=fake` — which production refuses.
 */
export function isDeployed(nodeEnv: NodeEnv): boolean {
  return nodeEnv === 'trial' || nodeEnv === 'staging' || nodeEnv === 'production';
}

/**
 * Which media provider a deployment declares (D19): `livekit` is real media,
 * enabled on purpose; `fake` is the in-process fake — sessions start and end,
 * no media flows — declared on purpose; null (unset) binds the fake only for
 * the development secret, and the provider that refuses everything otherwise.
 */
export type MediaProviderChoice = 'livekit' | 'fake';

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly logLevel: string;
  readonly http: {
    /**
     * Express `trust proxy`. Must match the deployment: trusting a proxy that
     * is not there lets any client forge its IP, and with it escape per-IP
     * rate limits.
     */
    readonly trustProxy: boolean | number;
    /**
     * Browser origins allowed to call the API (CORS) — e.g. the Flutter web
     * app's. Empty means no cross-origin browser access at all; native apps
     * are unaffected either way. Never a wildcard.
     */
    readonly corsOrigins: readonly string[];
  };
  readonly database: {
    readonly url: string;
    /**
     * Whether DATABASE_URL was actually supplied, as opposed to falling back to
     * the local development default. Modules use this to choose a persistent
     * adapter over an in-memory one, so "no database configured" is a deliberate
     * state rather than a connection error on the first query.
     */
    readonly configured: boolean;
  };
  readonly redis: { readonly url: string };
  readonly auth: {
    readonly jwtSecret: string;
    readonly jwtIssuer: string;
    readonly jwtAudience: string;
    /** Access token lifetime. Short, but not the revocation mechanism — sessions are. */
    readonly accessTtlSeconds: number;
    /** Absolute session lifetime. Refreshing does not extend it. */
    readonly refreshSessionTtlSeconds: number;
    /** How long the role → permission matrix is cached per process. */
    readonly rolePolicyCacheSeconds: number;
  };
  /** The media server (see `livekit-config.ts` for the two URLs and the version pin). */
  readonly livekit: {
    /** Client → LiveKit: the signalling URL a join ticket carries (ws: or wss:). */
    readonly url: string;
    /** API → LiveKit: the server API base the adapter calls (http: or https:). */
    readonly apiUrl: string;
    readonly apiKey: string;
    readonly apiSecret: string;
    /**
     * The LiveKit server release deployed (LIVEKIT_VERSION) — exactly the
     * pinned one whenever real media is enabled; null when unset.
     */
    readonly version: string | null;
  };
  readonly live: {
    /**
     * The listeners' soft cap per session, copied onto each session when it
     * starts: an engineering bound (PROVISIONAL 300, Q57), raised only after
     * load profiles measure more — never derived from a community's size.
     */
    readonly maxParticipantsPerSession: number;
    /** Seats above the cap for moderators and current speakers (PROVISIONAL 10, Q57). */
    readonly moderatorReserve: number;
    /**
     * How long a join ticket may START a media connection
     * (LIVE_JOIN_TOKEN_TTL_SECONDS; Q63, P7.2 decision Q-C): a whole number
     * of seconds from 1 to MAX_LIVE_JOIN_TOKEN_TTL_SECONDS, 120 when unset.
     * It bounds nothing once connected — the media server refreshes a
     * connected client's token itself — so short costs nothing but a join.
     */
    readonly joinTokenTtlSeconds: number;
    /**
     * The prefix of this deployment's media room names. The orphan sweep ends
     * every room of this form that no live session claims, so on a media
     * server other environments share it must be unique to the deployment.
     * Required when real media is enabled; null when unset, and the fake then
     * uses `live-`.
     */
    readonly roomNamePrefix: string | null;
    /**
     * `livekit` only when real media is explicitly enabled
     * (`LIVE_MEDIA_PROVIDER=livekit`), which the LiveKit-integration phase
     * turns on together with its hardening; `fake` only when a non-production
     * deployment explicitly runs without a media server
     * (`LIVE_MEDIA_PROVIDER=fake`, ADR 0037); null otherwise, and a deployment
     * then binds a provider that refuses every call (P6 audit, D19).
     */
    readonly mediaProvider: MediaProviderChoice | null;
  };
  readonly storage: {
    readonly localRoot: string;
    /**
     * Signs storage transfer URLs (see LocalStorageProvider). Its own key, not
     * the JWT key: one key, one purpose, and either can rotate alone.
     */
    readonly signingSecret: string;
  };
  readonly messaging: {
    /**
     * The community-chat capacity switch (community-chat.md §11.2): above
     * this many projected members a community chat refuses new posts until
     * gates G1–G4 hold for a larger size. An engineering bound (PROVISIONAL,
     * Q26), never a limit on a community's membership.
     */
    readonly communityChatMaxServedMembers: number;
  };
}

export class ConfigurationError extends Error {
  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigurationError';
  }
}

/** Values that must never survive into a deployed environment. */
const PLACEHOLDER_SECRETS = new Set([
  'change-me',
  'change-me-in-every-environment',
  'development-only-secret',
  'development-only-storage-secret',
  'devkey',
  'secret',
  '',
]);

/**
 * HS256 is only as strong as its key. RFC 7518 §3.2 requires a key at least
 * as long as the hash output: 256 bits, i.e. 32 bytes. The same bound applies
 * to the HMAC-SHA256 key that signs storage URLs, and to the LiveKit secret
 * that signs media join tokens once real media is enabled.
 */
const MIN_JWT_SECRET_BYTES = 32;
const MIN_STORAGE_SECRET_BYTES = 32;

const DAY = 24 * 60 * 60;

/** The join ticket's lifetime when LIVE_JOIN_TOKEN_TTL_SECONDS is unset (Q63). */
export const DEFAULT_LIVE_JOIN_TOKEN_TTL_SECONDS = 120;

/**
 * The longest join ticket a deployment may configure: ten minutes, as long as
 * a token the media server refreshes itself. Live checks the same bound again
 * where it mints a token (its `MAX_JOIN_TOKEN_TTL_SECONDS`, audit D24): the
 * provider's SDK reads a falsy lifetime as six hours.
 */
export const MAX_LIVE_JOIN_TOKEN_TTL_SECONDS = 600;

function readInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** An origin is scheme + host (+ port): nothing more, and never "*". */
const ORIGIN_SHAPE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

function readOrigins(raw: string | undefined, problems: string[]): readonly string[] {
  if (raw === undefined || raw.trim() === '') return Object.freeze([]);
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  for (const origin of origins) {
    if (!ORIGIN_SHAPE.test(origin)) {
      problems.push(
        `CORS_ORIGINS entry ${JSON.stringify(origin)} is not an origin (https://host[:port])`,
      );
    }
  }
  return Object.freeze(origins);
}

/**
 * Express `trust proxy`: `true`, `false` or a whole number of hops. Anything
 * else is refused rather than read as `false`: a mistyped value would
 * otherwise make every client one address behind the proxy, and every per-IP
 * rate limit one shared limit. A deployed environment names it — `false`
 * included — because there the API is meant to sit behind a known proxy.
 */
function readTrustProxy(
  raw: string | undefined,
  deployment: { readonly deployed: boolean; readonly environment: NodeEnv },
  problems: string[],
): boolean | number {
  if (raw === undefined || raw.trim() === '') {
    if (deployment.deployed) {
      problems.push(
        `TRUST_PROXY is required in ${deployment.environment} (true, false or a number of hops)`,
      );
    }
    return false;
  }
  const value = raw.trim();
  if (value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d{1,2}$/.test(value)) return Number(value);
  problems.push(`TRUST_PROXY must be true, false or a number of hops, not ${JSON.stringify(raw)}`);
  return false;
}

/**
 * A whole number, or the fallback when unset. Anything else — `1.5`, `12abc`
 * — is NaN, for the caller to refuse, rather than a number `parseInt` would
 * quietly make of it.
 */
function readWholeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^\s*-?\d+\s*$/.test(raw) ? Number(raw) : Number.NaN;
}

/**
 * A media room name prefix: short, and only characters every media server
 * accepts in a room name. The `.` that separates a media reset's epoch may
 * appear in it: room names are matched as text, never as a pattern.
 */
const ROOM_NAME_PREFIX_SHAPE = /^[A-Za-z0-9._-]{1,48}$/;

/** Unset means development; anything but the four known environments is a mistake. */
function readNodeEnv(raw: string | undefined, problems: string[]): NodeEnv {
  if (raw === undefined || raw.trim() === '') return 'development';
  if ((NODE_ENVS as readonly string[]).includes(raw)) return raw as NodeEnv;
  problems.push(
    `NODE_ENV must be development, test, trial, staging or production, not ${JSON.stringify(raw)}`,
  );
  // Checked as the strictest environment meanwhile; the boot is refused anyway.
  return 'production';
}

/**
 * A media provider is bound only on explicit choice (D19): `livekit` or
 * `fake`; anything else is a mistake. The fake is never production's: real
 * people would join sessions that carry no sound, with nothing to say so.
 */
function readMediaProvider(
  raw: string | undefined,
  nodeEnv: NodeEnv,
  problems: string[],
): MediaProviderChoice | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (raw === 'livekit') return 'livekit';
  if (raw === 'fake') {
    if (nodeEnv === 'production') {
      problems.push('LIVE_MEDIA_PROVIDER=fake is refused in production: no media would flow');
    }
    return 'fake';
  }
  problems.push(
    `LIVE_MEDIA_PROVIDER must be "livekit", "fake" or unset, not ${JSON.stringify(raw)}`,
  );
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];
  const nodeEnv = readNodeEnv(env.NODE_ENV, problems);
  const deployed = isDeployed(nodeEnv);
  const mediaProvider = readMediaProvider(env.LIVE_MEDIA_PROVIDER, nodeEnv, problems);
  // A deployment that declares the fake runs no media server, so it has no
  // LiveKit settings to demand. Every other deployed environment does, real
  // media enabled or not (staging hands its LiveKit server the secret either way).
  const mediaServerSettingsRequired = deployed && mediaProvider !== 'fake';

  /** Where `enforced`, a setting must be supplied; elsewhere a local default is fine. */
  const requiredWhen = (enforced: boolean, key: string, devDefault: string): string => {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value;
    if (enforced) problems.push(`${key} is required in ${nodeEnv}`);
    return devDefault;
  };
  const secretWhen = (enforced: boolean, key: string, devDefault: string): string => {
    const value = requiredWhen(enforced, key, devDefault);
    if (enforced && PLACEHOLDER_SECRETS.has(value)) {
      problems.push(`${key} still holds a placeholder value`);
    }
    return value;
  };
  /** In a deployed environment a setting must be supplied; elsewhere a local default is fine. */
  const required = (key: string, devDefault: string): string =>
    requiredWhen(deployed, key, devDefault);
  const secret = (key: string, devDefault: string): string => secretWhen(deployed, key, devDefault);

  const jwtSecret = secret('JWT_SECRET', 'development-only-secret');
  if (deployed && Buffer.byteLength(jwtSecret, 'utf8') < MIN_JWT_SECRET_BYTES) {
    problems.push(`JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes in ${nodeEnv}`);
  }

  const storageSigningSecret = secret('STORAGE_SIGNING_SECRET', 'development-only-storage-secret');
  if (deployed && Buffer.byteLength(storageSigningSecret, 'utf8') < MIN_STORAGE_SECRET_BYTES) {
    problems.push(
      `STORAGE_SIGNING_SECRET must be at least ${MIN_STORAGE_SECRET_BYTES} bytes in ${nodeEnv}`,
    );
  }
  if (deployed && storageSigningSecret === jwtSecret) {
    // One leaked key must not forge both sessions and file links.
    problems.push('STORAGE_SIGNING_SECRET must differ from JWT_SECRET');
  }

  const communityChatMaxServedMembers = readInt(
    env.MESSAGING_COMMUNITY_CHAT_MAX_SERVED_MEMBERS,
    250,
  );
  if (communityChatMaxServedMembers < 0) {
    problems.push('MESSAGING_COMMUNITY_CHAT_MAX_SERVED_MEMBERS must not be negative');
  }

  const accessTtlSeconds = readInt(env.JWT_ACCESS_TTL, 900);
  const refreshSessionTtlSeconds = readInt(env.REFRESH_SESSION_TTL_SECONDS, 30 * DAY);
  if (accessTtlSeconds <= 0 || refreshSessionTtlSeconds <= accessTtlSeconds) {
    problems.push('REFRESH_SESSION_TTL_SECONDS must exceed a positive JWT_ACCESS_TTL');
  }

  const livekitApiKey = requiredWhen(mediaServerSettingsRequired, 'LIVEKIT_API_KEY', 'devkey');
  const livekitApiSecret = secretWhen(
    mediaServerSettingsRequired,
    'LIVEKIT_API_SECRET',
    'development-only-secret',
  );

  const maxParticipantsPerSession = readWholeNumber(env.LIVE_MAX_PARTICIPANTS_PER_SESSION, 300);
  if (!Number.isSafeInteger(maxParticipantsPerSession) || maxParticipantsPerSession < 1) {
    problems.push('LIVE_MAX_PARTICIPANTS_PER_SESSION must be a whole number of at least 1');
  }
  const moderatorReserve = readWholeNumber(env.LIVE_MODERATOR_RESERVE, 10);
  if (!Number.isSafeInteger(moderatorReserve) || moderatorReserve < 0) {
    problems.push('LIVE_MODERATOR_RESERVE must be a whole number, 0 or more');
  }
  const joinTokenTtlSeconds = readWholeNumber(
    env.LIVE_JOIN_TOKEN_TTL_SECONDS,
    DEFAULT_LIVE_JOIN_TOKEN_TTL_SECONDS,
  );
  if (
    !Number.isSafeInteger(joinTokenTtlSeconds) ||
    joinTokenTtlSeconds < 1 ||
    joinTokenTtlSeconds > MAX_LIVE_JOIN_TOKEN_TTL_SECONDS
  ) {
    problems.push(
      `LIVE_JOIN_TOKEN_TTL_SECONDS must be a whole number of seconds from 1 to ${MAX_LIVE_JOIN_TOKEN_TTL_SECONDS}`,
    );
  }
  const rawPrefix = env.LIVE_ROOM_NAME_PREFIX;
  const roomNamePrefix = rawPrefix === undefined || rawPrefix.trim() === '' ? null : rawPrefix;
  if (roomNamePrefix !== null && !ROOM_NAME_PREFIX_SHAPE.test(roomNamePrefix)) {
    problems.push(
      'LIVE_ROOM_NAME_PREFIX must be 1 to 48 characters, each a letter, a digit, ".", "_" or "-"',
    );
  }
  const livekitServer = readLiveKitServer(
    env,
    {
      enabled: mediaProvider === 'livekit',
      deployed: mediaServerSettingsRequired,
      environment: nodeEnv,
    },
    problems,
  );
  if (mediaProvider === 'livekit') {
    // Real media is enabled on purpose, so it must be real, whatever NODE_ENV
    // says: this deployment's own room names (the orphan sweep ends every room
    // of their form that no session claims), a key and a secret set on
    // purpose — never a development default — the key not a well-known
    // placeholder, and the secret as strong as HS256 needs and its own: one
    // leaked key must not forge sessions, file links and media grants alike.
    if (roomNamePrefix === null) {
      problems.push('LIVE_ROOM_NAME_PREFIX is required when LIVE_MEDIA_PROVIDER=livekit');
    }
    // A deployed environment has reported a missing key or secret already.
    if (env.LIVEKIT_API_KEY === undefined) {
      if (!deployed) problems.push('LIVEKIT_API_KEY is required when LIVE_MEDIA_PROVIDER=livekit');
    } else if (PLACEHOLDER_SECRETS.has(livekitApiKey)) {
      problems.push('LIVEKIT_API_KEY must not be a placeholder when LIVE_MEDIA_PROVIDER=livekit');
    }
    if (env.LIVEKIT_API_SECRET === undefined) {
      if (!deployed) {
        problems.push('LIVEKIT_API_SECRET is required when LIVE_MEDIA_PROVIDER=livekit');
      }
    } else if (PLACEHOLDER_SECRETS.has(livekitApiSecret)) {
      // A deployed environment refuses a placeholder secret already, whatever the provider.
      if (!deployed) {
        problems.push(
          'LIVEKIT_API_SECRET must not be a placeholder when LIVE_MEDIA_PROVIDER=livekit',
        );
      }
    } else {
      if (Buffer.byteLength(livekitApiSecret, 'utf8') < MIN_JWT_SECRET_BYTES) {
        problems.push(
          `LIVEKIT_API_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes when LIVE_MEDIA_PROVIDER=livekit`,
        );
      }
    }
  }
  // Never one secret for two jobs — with real media enabled, and in every
  // deployed environment, where compose hands the LiveKit server its secret
  // whether or not the API binds real media: a leaked LiveKit secret must not
  // forge sessions or file links (P7.1, decision 4; brief decision G).
  if (
    (mediaProvider === 'livekit' || deployed) &&
    env.LIVEKIT_API_SECRET !== undefined &&
    !PLACEHOLDER_SECRETS.has(livekitApiSecret)
  ) {
    if (livekitApiSecret === jwtSecret) {
      problems.push('LIVEKIT_API_SECRET must differ from JWT_SECRET');
    }
    if (livekitApiSecret === storageSigningSecret) {
      problems.push('LIVEKIT_API_SECRET must differ from STORAGE_SIGNING_SECRET');
    }
  }

  const config: AppConfig = Object.freeze({
    nodeEnv,
    port: readInt(env.PORT, 3000),
    logLevel: env.LOG_LEVEL ?? (deployed ? 'info' : 'debug'),
    http: Object.freeze({
      trustProxy: readTrustProxy(env.TRUST_PROXY, { deployed, environment: nodeEnv }, problems),
      corsOrigins: readOrigins(env.CORS_ORIGINS, problems),
    }),
    database: Object.freeze({
      url: required('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/institution'),
      configured: (env.DATABASE_URL ?? '').trim() !== '',
    }),
    redis: Object.freeze({ url: required('REDIS_URL', 'redis://localhost:6379') }),
    auth: Object.freeze({
      jwtSecret,
      jwtIssuer: env.JWT_ISSUER ?? 'institution-api',
      jwtAudience: env.JWT_AUDIENCE ?? 'institution-clients',
      accessTtlSeconds,
      refreshSessionTtlSeconds,
      rolePolicyCacheSeconds: readInt(env.ROLE_POLICY_CACHE_SECONDS, 30),
    }),
    livekit: Object.freeze({
      url: livekitServer.url,
      apiUrl: livekitServer.apiUrl,
      apiKey: livekitApiKey,
      apiSecret: livekitApiSecret,
      version: livekitServer.version,
    }),
    live: Object.freeze({
      maxParticipantsPerSession,
      moderatorReserve,
      joinTokenTtlSeconds,
      roomNamePrefix,
      mediaProvider,
    }),
    storage: Object.freeze({
      localRoot: env.STORAGE_LOCAL_ROOT ?? './.storage',
      signingSecret: storageSigningSecret,
    }),
    messaging: Object.freeze({ communityChatMaxServedMembers }),
  });

  if (problems.length > 0) throw new ConfigurationError(problems);
  return config;
}

/** DI token — nothing imports the concrete object directly. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * The single place that reads `process.env`.
 *
 * Every setting is declared, validated and frozen here, so no module ever reads
 * undeclared configuration and a misconfigured deployment fails at boot rather
 * than at the first request. Secrets are values, never logged (see the redaction
 * list in `platform/logging`).
 */

export type NodeEnv = 'development' | 'test' | 'production';

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
  readonly livekit: {
    readonly url: string;
    readonly apiKey: string;
    readonly apiSecret: string;
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
     * turns on together with its hardening; null otherwise, and a deployment
     * then binds a provider that refuses every call (P6 audit, D19).
     */
    readonly mediaProvider: 'livekit' | null;
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

/** Values that must never survive into a production deployment. */
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

function readTrustProxy(raw: string | undefined): boolean | number {
  if (raw === undefined || raw.trim() === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  const hops = Number.parseInt(raw, 10);
  return Number.isNaN(hops) ? false : hops;
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

/** Real media is bound only on explicit opt-in (D19); anything but `livekit` is a mistake. */
function readMediaProvider(raw: string | undefined, problems: string[]): 'livekit' | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (raw === 'livekit') return 'livekit';
  problems.push(`LIVE_MEDIA_PROVIDER must be "livekit" or unset, not ${JSON.stringify(raw)}`);
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as NodeEnv;
  const isProduction = nodeEnv === 'production';
  const problems: string[] = [];

  /** In production a setting must be supplied; elsewhere a local default is fine. */
  const required = (key: string, devDefault: string): string => {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value;
    if (isProduction) problems.push(`${key} is required in production`);
    return devDefault;
  };

  const secret = (key: string, devDefault: string): string => {
    const value = required(key, devDefault);
    if (isProduction && PLACEHOLDER_SECRETS.has(value)) {
      problems.push(`${key} still holds a placeholder value`);
    }
    return value;
  };

  const jwtSecret = secret('JWT_SECRET', 'development-only-secret');
  if (isProduction && Buffer.byteLength(jwtSecret, 'utf8') < MIN_JWT_SECRET_BYTES) {
    problems.push(`JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes in production`);
  }

  const storageSigningSecret = secret('STORAGE_SIGNING_SECRET', 'development-only-storage-secret');
  if (isProduction && Buffer.byteLength(storageSigningSecret, 'utf8') < MIN_STORAGE_SECRET_BYTES) {
    problems.push(
      `STORAGE_SIGNING_SECRET must be at least ${MIN_STORAGE_SECRET_BYTES} bytes in production`,
    );
  }
  if (isProduction && storageSigningSecret === jwtSecret) {
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

  const livekitApiKey = required('LIVEKIT_API_KEY', 'devkey');
  const livekitApiSecret = secret('LIVEKIT_API_SECRET', 'development-only-secret');

  const maxParticipantsPerSession = readWholeNumber(env.LIVE_MAX_PARTICIPANTS_PER_SESSION, 300);
  if (!Number.isSafeInteger(maxParticipantsPerSession) || maxParticipantsPerSession < 1) {
    problems.push('LIVE_MAX_PARTICIPANTS_PER_SESSION must be a whole number of at least 1');
  }
  const moderatorReserve = readWholeNumber(env.LIVE_MODERATOR_RESERVE, 10);
  if (!Number.isSafeInteger(moderatorReserve) || moderatorReserve < 0) {
    problems.push('LIVE_MODERATOR_RESERVE must be a whole number, 0 or more');
  }
  const rawPrefix = env.LIVE_ROOM_NAME_PREFIX;
  const roomNamePrefix = rawPrefix === undefined || rawPrefix.trim() === '' ? null : rawPrefix;
  if (roomNamePrefix !== null && !ROOM_NAME_PREFIX_SHAPE.test(roomNamePrefix)) {
    problems.push(
      'LIVE_ROOM_NAME_PREFIX must be 1 to 48 characters, each a letter, a digit, ".", "_" or "-"',
    );
  }
  const mediaProvider = readMediaProvider(env.LIVE_MEDIA_PROVIDER, problems);
  if (mediaProvider === 'livekit') {
    // Real media is enabled on purpose, so it must be real, whatever NODE_ENV
    // says: this deployment's own room names (the orphan sweep ends every room
    // of their form that no session claims), a key that is not a well-known
    // placeholder, and a secret as strong as HS256 needs.
    if (roomNamePrefix === null) {
      problems.push('LIVE_ROOM_NAME_PREFIX is required when LIVE_MEDIA_PROVIDER=livekit');
    }
    if (PLACEHOLDER_SECRETS.has(livekitApiKey)) {
      problems.push('LIVEKIT_API_KEY must not be a placeholder when LIVE_MEDIA_PROVIDER=livekit');
    }
    // In production a placeholder secret is refused already, whatever the provider.
    if (!isProduction && PLACEHOLDER_SECRETS.has(livekitApiSecret)) {
      problems.push(
        'LIVEKIT_API_SECRET must not be a placeholder when LIVE_MEDIA_PROVIDER=livekit',
      );
    }
    if (Buffer.byteLength(livekitApiSecret, 'utf8') < MIN_JWT_SECRET_BYTES) {
      problems.push(
        `LIVEKIT_API_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes when LIVE_MEDIA_PROVIDER=livekit`,
      );
    }
  }

  const config: AppConfig = Object.freeze({
    nodeEnv,
    port: readInt(env.PORT, 3000),
    logLevel: env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
    http: Object.freeze({
      trustProxy: readTrustProxy(env.TRUST_PROXY),
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
      url: required('LIVEKIT_URL', 'ws://localhost:7880'),
      apiKey: livekitApiKey,
      apiSecret: livekitApiSecret,
    }),
    live: Object.freeze({
      maxParticipantsPerSession,
      moderatorReserve,
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

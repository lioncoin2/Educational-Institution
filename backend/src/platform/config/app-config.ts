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
  readonly storage: { readonly localRoot: string };
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
  'devkey',
  'secret',
  '',
]);

/**
 * HS256 is only as strong as its key. RFC 7518 §3.2 requires a key at least
 * as long as the hash output: 256 bits, i.e. 32 bytes.
 */
const MIN_JWT_SECRET_BYTES = 32;

const DAY = 24 * 60 * 60;

function readInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function readTrustProxy(raw: string | undefined): boolean | number {
  if (raw === undefined || raw.trim() === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  const hops = Number.parseInt(raw, 10);
  return Number.isNaN(hops) ? false : hops;
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

  const accessTtlSeconds = readInt(env.JWT_ACCESS_TTL, 900);
  const refreshSessionTtlSeconds = readInt(env.REFRESH_SESSION_TTL_SECONDS, 30 * DAY);
  if (accessTtlSeconds <= 0 || refreshSessionTtlSeconds <= accessTtlSeconds) {
    problems.push('REFRESH_SESSION_TTL_SECONDS must exceed a positive JWT_ACCESS_TTL');
  }

  const config: AppConfig = Object.freeze({
    nodeEnv,
    port: readInt(env.PORT, 3000),
    logLevel: env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
    http: Object.freeze({ trustProxy: readTrustProxy(env.TRUST_PROXY) }),
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
      apiKey: required('LIVEKIT_API_KEY', 'devkey'),
      apiSecret: secret('LIVEKIT_API_SECRET', 'development-only-secret'),
    }),
    storage: Object.freeze({ localRoot: env.STORAGE_LOCAL_ROOT ?? './.storage' }),
  });

  if (problems.length > 0) throw new ConfigurationError(problems);
  return config;
}

/** DI token — nothing imports the concrete object directly. */
export const APP_CONFIG = Symbol('APP_CONFIG');

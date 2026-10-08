import { writeFileSync } from 'node:fs';

/**
 * CI-only provisioning client for the Flutter Web LiveKit E2E.
 *
 * It orchestrates the EXISTING public HTTP API of an already-running ephemeral
 * stack to produce the two runtime values the Flutter harness needs:
 *
 *   POST /auth/login                               → accessToken
 *   POST /communities                              → communityId
 *   POST /live/communities/:communityId/sessions   → sessionId (state "live")
 *
 * It owns ONLY orchestration. It creates no owner (the `bootstrap-owner` CLI
 * does that first — the owner is assumed to exist), signs no token, writes no
 * database, and does NOT obtain the LiveKit media token — the Flutter harness
 * calls `POST /live/sessions/:id/join` itself for that. Authentication,
 * authorization and all business rules stay in the backend.
 *
 * Run (against a running stack, after `bootstrap-owner`):
 *
 *   E2E_BASE_URL=http://127.0.0.1:3000 \
 *   E2E_OWNER_EMAIL=owner@institution.test \
 *   E2E_OWNER_PASSWORD=... \
 *   E2E_OUTPUT_FILE=/tmp/e2e.json \
 *     ts-node test/e2e/provision-live-session.ts
 *
 * Credentials come only from the environment; the access token is written to
 * `E2E_OUTPUT_FILE` (mode 0600) and NEVER printed. There is no secret logging.
 */

/** A minimal HTTP seam so the orchestration is unit-testable without a server. */
export type HttpClient = (
  method: string,
  path: string,
  options?: { readonly token?: string; readonly body?: unknown },
) => Promise<{ readonly status: number; readonly body: Record<string, unknown> }>;

export interface ProvisionConfig {
  readonly baseUrl: string;
  readonly ownerEmail: string;
  readonly ownerPassword: string;
  /** Deterministic, clearly-ephemeral title (1–100 chars). */
  readonly communityTitle?: string;
}

export interface Provisioned {
  readonly accessToken: string;
  readonly sessionId: string;
  readonly communityId: string;
}

export type ProvisionStage = 'config' | 'network' | 'login' | 'community' | 'live' | 'malformed';

/** An actionable failure. Its message is always safe to log — never a token,
 * a password or a response body, only the stage, the HTTP status and a hint. */
export class ProvisionError extends Error {
  constructor(
    readonly stage: ProvisionStage,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProvisionError';
  }
}

export const DEFAULT_COMMUNITY_TITLE = 'E2E LiveKit fixture (ephemeral)';

function expectStatus(
  stage: ProvisionStage,
  status: number,
  allowed: readonly number[],
  hint: string,
): void {
  if (!allowed.includes(status)) {
    throw new ProvisionError(stage, status, `${hint} (HTTP ${status})`);
  }
}

/** Reads a required non-empty string field, naming the FIELD on failure —
 * never its value. */
function requireString(
  body: Record<string, unknown>,
  field: string,
  stage: ProvisionStage,
): string {
  const value = body[field];
  if (typeof value === 'string' && value.length > 0) return value;
  throw new ProvisionError('malformed', 0, `the ${stage} response did not include a "${field}"`);
}

/** Orchestrates login → community → live start. Pure: the HTTP seam is
 * injected, so this is fully unit-testable. Never logs. */
export async function provisionLiveSession(
  config: ProvisionConfig,
  http: HttpClient,
): Promise<Provisioned> {
  const login = await http('POST', '/auth/login', {
    body: { identifier: config.ownerEmail, password: config.ownerPassword },
  });
  expectStatus(
    'login',
    login.status,
    [200],
    'login failed — check the owner credentials and that bootstrap-owner ran',
  );
  const accessToken = requireString(login.body, 'accessToken', 'login');

  const community = await http('POST', '/communities', {
    token: accessToken,
    body: { title: config.communityTitle ?? DEFAULT_COMMUNITY_TITLE },
  });
  expectStatus('community', community.status, [200, 201], 'community creation failed');
  const communityId = requireString(community.body, 'id', 'community');

  const session = await http(
    'POST',
    `/live/communities/${encodeURIComponent(communityId)}/sessions`,
    { token: accessToken },
  );
  expectStatus(
    'live',
    session.status,
    [200, 201],
    'live session start failed — is LiveKit configured and reachable?',
  );
  const sessionId = requireString(session.body, 'id', 'live');
  if (session.body.state !== 'live') {
    throw new ProvisionError(
      'live',
      session.status,
      'the live session is not active (its state must be "live")',
    );
  }

  return { accessToken, sessionId, communityId };
}

/** What is safe to print anywhere: the resource ids, the token redacted. */
export function redactedSummary(provisioned: Provisioned): Record<string, string> {
  return {
    communityId: provisioned.communityId,
    sessionId: provisioned.sessionId,
    accessToken: '<redacted>',
  };
}

// ── CLI composition root (runs only when executed directly) ────────────────

/** A real `fetch` HTTP seam against [baseUrl] (trailing slash tolerated). */
export function fetchHttpClient(baseUrl: string): HttpClient {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return async (method, path, options = {}) => {
    let response: Response;
    try {
      response = await fetch(`${root}${path}`, {
        method,
        headers: {
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      // The cause is swallowed on purpose: a stray fetch error can carry the
      // request (and its Authorization header) in its message.
      throw new ProvisionError(
        'network',
        0,
        `backend unreachable at ${root} — is the stack up and healthy?`,
      );
    }
    const text = await response.text();
    let body: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object') {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        body = {};
      }
    }
    return { status: response.status, body };
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new ProvisionError('config', 0, `missing required env ${name}`);
  }
  return value;
}

/** Writes {accessToken, sessionId} to E2E_OUTPUT_FILE (0600). stdout is used
 * only when E2E_ALLOW_STDOUT=1 is set deliberately; otherwise, refusing to
 * print a credential, it fails with guidance. */
function emit(provisioned: Provisioned): void {
  const payload = JSON.stringify({
    accessToken: provisioned.accessToken,
    sessionId: provisioned.sessionId,
    communityId: provisioned.communityId,
  });
  const outputFile = process.env.E2E_OUTPUT_FILE;
  if (outputFile !== undefined && outputFile.length > 0) {
    writeFileSync(outputFile, payload, { mode: 0o600 });
    process.stderr.write(
      `provisioned ${JSON.stringify(redactedSummary(provisioned))}; token written to ${outputFile}\n`,
    );
    return;
  }
  if (process.env.E2E_ALLOW_STDOUT === '1') {
    process.stdout.write(payload);
    return;
  }
  throw new ProvisionError(
    'config',
    0,
    'refusing to print a credential: set E2E_OUTPUT_FILE (preferred) or ' +
      'E2E_ALLOW_STDOUT=1 to print JSON to stdout deliberately',
  );
}

async function main(): Promise<void> {
  const baseUrl = requireEnv('E2E_BASE_URL');
  const config: ProvisionConfig = {
    baseUrl,
    ownerEmail: requireEnv('E2E_OWNER_EMAIL'),
    ownerPassword: requireEnv('E2E_OWNER_PASSWORD'),
    communityTitle: process.env.E2E_COMMUNITY_TITLE,
  };
  const provisioned = await provisionLiveSession(config, fetchHttpClient(baseUrl));
  emit(provisioned);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message =
      error instanceof ProvisionError
        ? `provision failed [${error.stage}]: ${error.message}`
        : 'provision failed: unexpected error';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

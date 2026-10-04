/**
 * P8 load harness — API + realtime load generator. Real runs only. It exercises
 * the application's real contracts through the public edge (nginx → api): a real
 * login for a bearer token, real `/realtime` WebSocket handshakes, and a paced
 * HTTP request loop. It never bypasses auth and never fabricates internal state.
 *
 * Credentials come from the environment (LOADTEST_API_*); nothing is hardcoded.
 * The realtime auth frame is the app's public wire contract
 * (src/modules/realtime/domain/protocol.ts: ClientFrame `{ type: 'auth', token }`,
 * REALTIME_PATH `/realtime`), inlined here to keep the tool self-contained and
 * runnable under ts-node without path-alias resolution.
 */
import WebSocket from 'ws';

const REALTIME_PATH = '/realtime';

export interface ApiEnv {
  /** Public HTTPS base, e.g. https://api-staging.adlink4.com */
  readonly base: string;
  readonly identifier: string;
  readonly password: string;
}

export function loadApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv | null {
  const base = env.LOADTEST_API_BASE;
  const identifier = env.LOADTEST_API_IDENTIFIER;
  const password = env.LOADTEST_API_PASSWORD;
  if (!base || !identifier || !password) return null;
  return { base, identifier, password };
}

export interface ApiRunResult {
  readonly wsOpened: number;
  readonly wsReady: number;
  readonly wsFailed: number;
  readonly httpOk: number;
  readonly httpError: number;
  readonly latencyMsP50: number;
  readonly latencyMsP99: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A ws frame payload (Buffer | ArrayBuffer | Buffer[]) as UTF-8 text. */
function rawToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** Logs in and returns a bearer access token, or throws. */
export async function login(env: ApiEnv): Promise<string> {
  const res = await fetch(`${env.base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: env.identifier, password: env.password }),
  });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  const body = (await res.json()) as { accessToken?: string };
  if (!body.accessToken) throw new Error('login returned no accessToken');
  return body.accessToken;
}

/** Opens one authenticated realtime socket; resolves true on a `ready` frame. */
function openRealtime(wsBase: string, token: string, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}${REALTIME_PATH}`);
    const timer = setTimeout(() => {
      ws.close();
      resolve(false);
    }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const frame = JSON.parse(rawToString(data)) as { type?: string };
        if (frame.type === 'ready') {
          clearTimeout(timer);
          resolve(true);
        }
      } catch {
        /* ignore non-JSON */
      }
    });
    ws.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] ?? 0);
}

export interface ApiRunOptions {
  readonly connections: number;
  readonly requestsPerSecond: number;
  readonly holdSeconds: number;
}

/**
 * Drives `connections` realtime sockets and a `requestsPerSecond` HTTP loop
 * against GET /health/ready (the public path through nginx) for `holdSeconds`.
 */
export async function runApiScenario(env: ApiEnv, opts: ApiRunOptions): Promise<ApiRunResult> {
  const token = await login(env);
  const wsBase = env.base.replace(/^http/, 'ws');
  const sockets = Array.from({ length: opts.connections }, () => openRealtime(wsBase, token));
  const wsResults = await Promise.all(sockets);
  const wsReady = wsResults.filter(Boolean).length;

  const latencies: number[] = [];
  let httpOk = 0;
  let httpError = 0;
  const perTick = Math.max(1, Math.round(opts.requestsPerSecond));
  for (let second = 0; second < opts.holdSeconds; second += 1) {
    const batch = Array.from({ length: perTick }, async () => {
      const t0 = Date.now();
      try {
        const res = await fetch(`${env.base}/health/ready`);
        latencies.push(Date.now() - t0);
        if (res.ok) httpOk += 1;
        else httpError += 1;
      } catch {
        httpError += 1;
      }
    });
    await Promise.all(batch);
    await sleep(1000);
  }

  return {
    wsOpened: opts.connections,
    wsReady,
    wsFailed: opts.connections - wsReady,
    httpOk,
    httpError,
    latencyMsP50: percentile(latencies, 50),
    latencyMsP99: percentile(latencies, 99),
  };
}

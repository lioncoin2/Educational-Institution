import type { INestApplication } from '@nestjs/common';

export interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
  readonly raw: string;
}

export interface RunningApi {
  readonly app: INestApplication;
  /** e.g. http://127.0.0.1:41234 — for raw requests the JSON helper cannot make. */
  readonly base: string;
  /** Every response body this API has returned — for "never leaks" assertions. */
  readonly transcript: string[];
  call(
    method: string,
    path: string,
    options?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<ApiResponse>;
  close(): Promise<void>;
}

/**
 * Boots the real application — the same AppModule and the same configureApp()
 * the server uses — on a random port, with no database (in-memory adapters)
 * and silent logs. Imported lazily so the environment is set first.
 */
export async function startApi(env: Record<string, string> = {}): Promise<RunningApi> {
  delete process.env.DATABASE_URL;
  process.env.LOG_LEVEL = 'silent';
  process.env.JWT_SECRET = 'api-test-secret-that-is-at-least-32-bytes';
  Object.assign(process.env, env);

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const { APP_CONFIG } = await import('../../src/platform/config/app-config');
  const { configureApp } = await import('../../src/platform/http/configure-app');

  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app, app.get(APP_CONFIG));
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const transcript: string[] = [];

  return {
    app,
    base,
    transcript,
    async call(method, path, options = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const raw = await response.text();
      transcript.push(raw);
      return {
        status: response.status,
        headers: response.headers,
        raw,
        body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>),
      };
    },
    async close() {
      await app.close();
    },
  };
}

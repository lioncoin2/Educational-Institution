import { startApi, type RunningApi } from '../support/api-client';

/**
 * Cross-origin access, for the Flutter web app: exactly the configured
 * origins, and nobody else. Native apps never send an Origin and are
 * unaffected.
 */
describe('CORS', () => {
  let api: RunningApi;
  const ALLOWED = 'http://localhost:8080';

  beforeAll(async () => {
    api = await startApi({ CORS_ORIGINS: ALLOWED });
  }, 60_000);

  afterAll(async () => {
    await api.close();
    delete process.env.CORS_ORIGINS;
  });

  const preflight = (origin: string) =>
    fetch(`${api.base}/messaging/conversations`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });

  it('answers a preflight from a listed origin', async () => {
    const response = await preflight(ALLOWED);
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
    // Bearer tokens, never cookies: credentials are never allowed.
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('grants nothing to any other origin', async () => {
    const response = await preflight('https://evil.example');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('exposes the headers a browser client needs to read', async () => {
    const response = await fetch(`${api.base}/health/live`, { headers: { origin: ALLOWED } });
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(response.headers.get('access-control-expose-headers')).toContain('content-range');
  });
});

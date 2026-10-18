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

  const preflight = (origin: string, method = 'GET', path = '/messaging/conversations') =>
    fetch(`${api.base}${path}`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type',
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

  // The web app edits preferences and the academic structure with PATCH; a
  // preflight that refused it made those screens fail on the web only.
  it('lets a listed origin send every method the API serves, PATCH included', async () => {
    const response = await preflight(ALLOWED, 'PATCH', '/notifications/preferences');
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(response.headers.get('access-control-allow-methods')?.split(',')).toEqual([
      'GET',
      'HEAD',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
    ]);
    expect(response.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('grants nothing to any other origin, whatever the method', async () => {
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await preflight('https://evil.example', method);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('exposes the headers a browser client needs to read', async () => {
    const response = await fetch(`${api.base}/health/live`, { headers: { origin: ALLOWED } });
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(response.headers.get('access-control-expose-headers')).toContain('content-range');
  });
});

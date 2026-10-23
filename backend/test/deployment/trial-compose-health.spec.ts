import { environmentOf, mapping, readYaml, servicesOf, texts } from '../support/deployment-files';

/**
 * The isolated web Trial stack's container health checks, read from the
 * committed infra/compose.trial.yaml. A static contract test: it parses the
 * compose file and asserts the probe shapes only — it never starts, connects
 * to, or recreates a container, so it is deterministic and independent of the
 * live Trial.
 *
 * The contracts asserted, each on its own:
 *   - trial-api checks the application's readiness route with the image's own
 *     node (built-in fetch; no curl/wget in the runtime image), on the port it
 *     listens on, failing closed on a non-2xx or a connection error;
 *   - trial-redis checks liveness with a secret-safe redis-cli ping — the
 *     password is read from the REDIS_PASSWORD env var at run time, never in the
 *     probe's arguments (the same convention as the data-tier redis);
 *   - trial-db's existing pg_isready probe is left exactly as it was;
 *   - the API's start-ordering (db healthy, redis only started) is unchanged.
 */

const TRIAL_FILE = 'infra/compose.trial.yaml';
const services = servicesOf(readYaml(TRIAL_FILE), TRIAL_FILE);
const trialApi = services['trial-api'] ?? {};
const trialRedis = services['trial-redis'] ?? {};
const trialDb = services['trial-db'] ?? {};

/** The five keys a complete Docker health check declares. */
const HEALTHCHECK_KEYS = ['interval', 'retries', 'start_period', 'test', 'timeout'];

describe('the trial compose health checks', () => {
  it('defines exactly the three trial services', () => {
    expect(Object.keys(services).sort()).toEqual(['trial-api', 'trial-db', 'trial-redis']);
  });

  it('checks trial-api on its readiness route with the image’s own node, failing closed', () => {
    const healthcheck = mapping(trialApi.healthcheck, 'trial-api.healthcheck');
    expect(Object.keys(healthcheck).sort()).toEqual(HEALTHCHECK_KEYS);

    const test = texts(healthcheck.test, 'trial-api.healthcheck.test');
    // The image has no curl/wget; Node 22's built-in fetch is the probe.
    expect(test.slice(0, 3)).toEqual(['CMD', 'node', '-e']);
    const port = environmentOf(trialApi, 'services.trial-api').PORT;
    expect(test[3]).toContain(`fetch('http://127.0.0.1:${String(port)}/health/ready')`);
    // A successful response exits 0; a non-success response exits 1; a
    // connection error exits 1 — the probe is never falsely healthy.
    expect(test[3]).toContain('process.exit(r.ok ? 0 : 1)');
    expect(test[3]).toContain('() => process.exit(1)');

    expect({
      interval: healthcheck.interval,
      timeout: healthcheck.timeout,
      retries: healthcheck.retries,
      start_period: healthcheck.start_period,
    }).toEqual({ interval: '15s', timeout: '5s', retries: 3, start_period: '30s' });
  });

  it('checks trial-redis with a secret-safe ping that never embeds the password', () => {
    const healthcheck = mapping(trialRedis.healthcheck, 'trial-redis.healthcheck');
    expect(Object.keys(healthcheck).sort()).toEqual(HEALTHCHECK_KEYS);

    const test = texts(healthcheck.test, 'trial-redis.healthcheck.test');
    expect(test[0]).toBe('CMD-SHELL');
    const shell = test[1] ?? '';
    // The password is taken from the container's REDIS_PASSWORD env var at run
    // time (the $$ is compose's literal-dollar escape, so no interpolation puts
    // the secret into the committed file), and redis-cli reads it from
    // REDISCLI_AUTH rather than from a command-line flag.
    expect(shell).toBe('REDISCLI_AUTH="$$REDIS_PASSWORD" redis-cli ping | grep -q PONG');
    // Guard rails: the secret is never named for interpolation, and never passed
    // as a redis-cli `-a <password>` argument (which would leak into argv/logs).
    expect(shell).not.toContain('TRIAL_REDIS_PASSWORD');
    expect(shell).not.toMatch(/redis-cli\s+-a\b/);

    expect({
      interval: healthcheck.interval,
      timeout: healthcheck.timeout,
      retries: healthcheck.retries,
      start_period: healthcheck.start_period,
    }).toEqual({ interval: '10s', timeout: '3s', retries: 5, start_period: '5s' });
  });

  it('leaves the trial-db pg_isready health check exactly as it was', () => {
    const healthcheck = mapping(trialDb.healthcheck, 'trial-db.healthcheck');
    expect(healthcheck.test).toEqual(['CMD-SHELL', 'pg_isready -U trial -d trial -h 127.0.0.1']);
    expect({
      interval: healthcheck.interval,
      timeout: healthcheck.timeout,
      retries: healthcheck.retries,
      start_period: healthcheck.start_period,
    }).toEqual({ interval: '10s', timeout: '5s', retries: 5, start_period: '20s' });
  });

  it('keeps the API start-ordering unchanged: db healthy, redis only started', () => {
    expect(trialApi.depends_on).toEqual({
      'trial-db': { condition: 'service_healthy' },
      'trial-redis': { condition: 'service_started' },
    });
  });
});

import { buildInput } from '../cli/preflight';
import {
  type CheckResult,
  checkEnv,
  checkUrls,
  renderTable,
  summarize,
} from '../livekit/preflight';

describe('preflight (pure parts)', () => {
  it('reports missing livekit env as a fail and present env (redacted) as ok', () => {
    const missing = checkEnv({});
    expect(missing.find((r) => r.name === 'env: livekit')?.pass).toBe(false);
    const present = checkEnv({
      LOADTEST_LIVEKIT_URL: 'wss://livekit-staging.adlink4.com',
      LOADTEST_LIVEKIT_API_KEY: 'APIkey1234567',
      LOADTEST_LIVEKIT_API_SECRET: 'secretvalue9876',
    });
    const lk = present.find((r) => r.name === 'env: livekit');
    expect(lk?.pass).toBe(true);
    // the actual secret must never appear
    expect(lk?.detail).not.toContain('secretvalue9876');
    expect(lk?.detail).toContain('****');
  });

  it('warns when a target URL is local (off-box misconfig)', () => {
    const results = checkUrls('https://127.0.0.1:3000', 'wss://localhost:7880');
    expect(results.some((r) => r.level === 'warn' && r.name.includes('local'))).toBe(true);
  });

  it('fails a malformed livekit url', () => {
    const results = checkUrls(null, 'http://not-wss');
    expect(results.find((r) => r.name === 'url: livekit')?.pass).toBe(false);
  });

  it('summarizes pass/fail and renders a redacted table', () => {
    const results: CheckResult[] = [
      { name: 'env: livekit', pass: true, level: 'ok', detail: 'key ****4567' },
      { name: 'url: livekit local', pass: true, level: 'warn', detail: 'local host' },
      {
        name: 'livekit: auth',
        pass: false,
        level: 'fail',
        detail: 'token=eyJabc.def.ghijklmnop bad',
      },
    ];
    const s = summarize(results);
    expect(s).toEqual({ pass: false, oks: 1, warns: 1, fails: 1 });
    const table = renderTable(results);
    expect(table).toContain('PREFLIGHT FAIL');
    expect(table).toContain('PASS');
    expect(table).toContain('WARN');
    expect(table).toContain('FAIL');
    // any token-looking secret in a detail is redacted in the table
    expect(table).not.toContain('eyJabc.def.ghijklmnop');
  });

  it('builds input from args then env fallback', () => {
    const fromArgs = buildInput(['--target', 'https://a', '--livekit-url', 'wss://b'], {});
    expect(fromArgs).toMatchObject({ apiBase: 'https://a', livekitUrl: 'wss://b' });
    const fromEnv = buildInput([], {
      LOADTEST_API_BASE: 'https://e',
      LOADTEST_LIVEKIT_URL: 'wss://f',
    });
    expect(fromEnv).toMatchObject({ apiBase: 'https://e', livekitUrl: 'wss://f' });
  });
});

import { mask, redact, redactSecret } from '../core/redact';

describe('secret redaction', () => {
  it('masks a value keeping only a short tail', () => {
    expect(mask('abcd')).toBe('****');
    expect(mask('supersecretvalue')).toBe('****alue');
  });

  it('redacts JWTs anywhere in a string', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc123DEF456ghiJKLmnoPQRstuvWXyz0123456789';
    const out = redact(`connect failed with token ${jwt} oops`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('****');
  });

  it('redacts secret key/value pairs by key name', () => {
    expect(redact('api_secret=APIabc123def456')).toMatch(/api_secret=\*\*\*\*/);
    expect(redact('password: hunter2strong')).toMatch(/password: \*\*\*\*/);
    expect(redact('Authorization: Bearer zzzzyyyyxxxx')).toMatch(/Authorization: \*\*\*\*/);
  });

  it('leaves non-secret text intact', () => {
    expect(redact('HTTP 200 OK, 42 rooms')).toBe('HTTP 200 OK, 42 rooms');
  });

  it('redactSecret masks or reports unset', () => {
    expect(redactSecret(undefined)).toBe('(unset)');
    expect(redactSecret('APIkey1234567')).toBe('****4567');
  });
});

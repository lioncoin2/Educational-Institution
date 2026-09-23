import { asId } from '../../../shared';
import {
  isSessionActive,
  openSession,
  revokeSession,
  rotateRefreshToken,
  sanitizeDevice,
  type AuthSession,
} from './auth-session';

const NOW = new Date('2026-09-01T08:00:00Z');
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

function session(): AuthSession {
  return openSession({
    id: asId<'AuthSession'>('s-1'),
    userId: asId<'User'>('u-1'),
    device: { platform: 'ios', label: 'Phone', appVersion: '1.0.0' },
    refreshTokenHash: 'hash-0',
    now: NOW,
    lifetimeSeconds: 3600,
  });
}

describe('auth session', () => {
  it('opens active, with no previous token and an absolute expiry', () => {
    const s = session();
    expect(isSessionActive(s, NOW)).toBe(true);
    expect(s.previousRefreshTokenHash).toBeNull();
    expect(s.generation).toBe(0);
    expect(s.expiresAt).toEqual(later(3600));
  });

  it('is inactive from the instant it expires', () => {
    const s = session();
    expect(isSessionActive(s, later(3599))).toBe(true);
    expect(isSessionActive(s, later(3600))).toBe(false);
  });

  it('retires the current token into "previous" on rotation', () => {
    const rotated = rotateRefreshToken(session(), 'hash-1', later(60));
    expect(rotated.refreshTokenHash).toBe('hash-1');
    expect(rotated.previousRefreshTokenHash).toBe('hash-0');
    expect(rotated.generation).toBe(1);
    expect(rotated.lastUsedAt).toEqual(later(60));
  });

  it('never extends the session when rotating', () => {
    const rotated = rotateRefreshToken(session(), 'hash-1', later(3000));
    expect(rotated.expiresAt).toEqual(session().expiresAt);
  });

  it('revokes idempotently, keeping the first time and reason', () => {
    const once = revokeSession(session(), 'logout', later(10));
    const twice = revokeSession(once, 'revoked_by_admin', later(20));
    expect(isSessionActive(once, later(10))).toBe(false);
    expect(twice.revokedAt).toEqual(later(10));
    expect(twice.revokedReason).toBe('logout');
  });
});

describe('device metadata', () => {
  it('maps unknown platforms to "unknown"', () => {
    expect(sanitizeDevice({ platform: 'windows-phone' }).platform).toBe('unknown');
    expect(sanitizeDevice({}).platform).toBe('unknown');
  });

  it('strips control characters, collapses whitespace and caps the label', () => {
    const device = sanitizeDevice({ label: `  Ahmad's\u0000   iPhone\n${'x'.repeat(200)}` });
    expect(device.label?.startsWith("Ahmad's iPhone x")).toBe(true);
    expect([...(device.label ?? '')].length).toBe(64);
  });

  it('stores nothing for an empty label', () => {
    expect(sanitizeDevice({ label: '   \u0007 ' }).label).toBeNull();
  });
});

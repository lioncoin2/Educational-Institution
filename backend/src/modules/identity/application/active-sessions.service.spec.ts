import { META, expectOk, identityHarness } from '../../../../test/support/identity-harness';
import { ACTIVE_SESSIONS_MAX_BATCH } from '../contracts/active-sessions';
import { IdentityActiveSessions } from './active-sessions.service';

const DAY = 24 * 60 * 60;

describe('active sessions (ADR 0058)', () => {
  async function signedIn() {
    const h = identityHarness();
    const ali = await h.seedUser({ email: 'ali@example.com' });
    const sara = await h.seedUser({ email: 'sara@example.com' });
    const phone = await h.signIn('ali@example.com');
    const tablet = await h.signIn('ali@example.com');
    const saras = await h.signIn('sara@example.com');
    const active = new IdentityActiveSessions(h.sessions, h.clock);
    return { h, ali, sara, phone, tablet, saras, active };
  }

  it('answers which sessions are live, for the account named with each', async () => {
    const { ali, sara, phone, tablet, saras, active } = await signedIn();
    const refs = [
      { userId: ali.id, sessionId: phone.sessionId },
      { userId: ali.id, sessionId: tablet.sessionId },
      { userId: sara.id, sessionId: saras.sessionId },
    ];
    expect(await active.activeAmong(refs)).toEqual(refs);
  });

  it('does not count a session that was signed out', async () => {
    const { h, ali, phone, tablet, active } = await signedIn();
    const principal = await h.resolvePrincipal.execute(phone.accessToken);
    expectOk(await h.logout.execute({ principal: principal!, meta: META }));
    expect(
      await active.activeAmong([
        { userId: ali.id, sessionId: phone.sessionId },
        { userId: ali.id, sessionId: tablet.sessionId },
      ]),
    ).toEqual([{ userId: ali.id, sessionId: tablet.sessionId }]);
  });

  it('does not count a session past its absolute expiry, by identity’s clock', async () => {
    const { h, ali, phone, active } = await signedIn();
    h.clock.advance(30 * DAY + 1);
    expect(await active.activeAmong([{ userId: ali.id, sessionId: phone.sessionId }])).toEqual([]);
  });

  it('does not count another account’s session, or one that never existed', async () => {
    const { ali, saras, active } = await signedIn();
    expect(
      await active.activeAmong([
        { userId: ali.id, sessionId: saras.sessionId },
        { userId: ali.id, sessionId: 'no-such-session' },
      ]),
    ).toEqual([]);
  });

  it('answers an empty question without a lookup, and refuses an oversized one', async () => {
    const { h, ali, active } = await signedIn();
    const lookups = jest.spyOn(h.sessions, 'findActiveByIds');
    expect(await active.activeAmong([])).toEqual([]);
    expect(lookups).not.toHaveBeenCalled();
    const tooMany = Array.from({ length: ACTIVE_SESSIONS_MAX_BATCH + 1 }, (_, i) => ({
      userId: ali.id,
      sessionId: `s-${i}`,
    }));
    await expect(active.activeAmong(tooMany)).rejects.toThrow(RangeError);
  });
});

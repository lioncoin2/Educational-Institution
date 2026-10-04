import { TokenVerifier, TrackSource } from 'livekit-server-sdk';

import {
  FLEET_TICKET_TTL_SECONDS,
  type LivekitEnv,
  type TicketRole,
  mintScopedTicket,
  scopedGrant,
} from '../livekit/tokens';

/**
 * Unit tests for the P8.4 scoped grant and join ticket (design §2 grant table):
 * one room, one identity, one role, 300 s, and NEVER any grant that creates,
 * lists, administers or records rooms. Tickets are decoded with the SDK's own
 * TokenVerifier under a test key/secret; nothing leaves the process.
 */

const ENV: LivekitEnv = {
  url: 'wss://livekit-staging.example.test',
  apiUrl: 'http://127.0.0.1:7880',
  apiKey: 'APIp84tokensspec',
  apiSecret: 'a-p84-tokens-spec-secret-long-enough-for-hs256',
};
const ROOM = 'loadtest-p84-0123456789abcdef';

/** Grants that would let a ticket create/list/administer/record rooms. */
const FORBIDDEN = ['roomCreate', 'roomAdmin', 'roomList', 'roomRecord', 'ingressAdmin', 'agent'];

const LISTENER_GRANT = {
  roomJoin: true,
  room: ROOM,
  canSubscribe: true,
  canPublish: false,
  canPublishSources: [],
  canPublishData: false,
  canUpdateOwnMetadata: false,
  hidden: false,
};

const PUBLISHER_GRANT = {
  ...LISTENER_GRANT,
  canSubscribe: false,
  canPublish: true,
};

const verify = (token: string, key = ENV.apiKey, secret = ENV.apiSecret) =>
  new TokenVerifier(key, secret).verify(token);

describe('livekit/tokens — scopedGrant', () => {
  it('listener: exact fields — join one room, subscribe only, visible', () => {
    expect(scopedGrant(ROOM, 'listener')).toStrictEqual(LISTENER_GRANT);
  });

  it('publisher: exact fields — join one room, publish the microphone only, no subscribe', () => {
    expect(scopedGrant(ROOM, 'publisher')).toStrictEqual({
      ...PUBLISHER_GRANT,
      canPublishSources: [TrackSource.MICROPHONE],
    });
  });

  it.each<TicketRole>(['listener', 'publisher'])(
    '%s: never carries roomCreate/roomAdmin/roomList/roomRecord/ingressAdmin/agent (absent, not false)',
    (role) => {
      const grant = scopedGrant(ROOM, role);
      for (const name of FORBIDDEN) expect(grant).not.toHaveProperty(name);
    },
  );

  it('returns a fresh object per call (no shared source array)', () => {
    const a = scopedGrant(ROOM, 'publisher');
    const b = scopedGrant(ROOM, 'publisher');
    expect(a).not.toBe(b);
    expect(a.canPublishSources).not.toBe(b.canPublishSources);
    expect(scopedGrant('loadtest-p84-other', 'listener').room).toBe('loadtest-p84-other');
  });
});

describe('livekit/tokens — mintScopedTicket (decoded with TokenVerifier)', () => {
  it('FLEET_TICKET_TTL_SECONDS is 300', () => {
    expect(FLEET_TICKET_TTL_SECONDS).toBe(300);
  });

  it('listener ticket: url as given; sub = identity; iss = key; exact video grant', async () => {
    const ticket = await mintScopedTicket(ENV, {
      identity: 'p84-01234567-L00042',
      room: ROOM,
      role: 'listener',
    });
    expect(Object.keys(ticket).sort()).toEqual(['token', 'url']);
    expect(ticket.url).toBe(ENV.url);
    const claims = await verify(ticket.token);
    expect(claims.sub).toBe('p84-01234567-L00042');
    expect(claims.iss).toBe(ENV.apiKey);
    expect(claims.video).toStrictEqual(LISTENER_GRANT);
    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.video?.room).toBe(ROOM);
    expect(claims.video?.canPublish).toBe(false);
  });

  it('publisher ticket: canPublish with sources exactly [microphone]', async () => {
    const ticket = await mintScopedTicket(ENV, {
      identity: 'p84-01234567-P0',
      room: ROOM,
      role: 'publisher',
    });
    const claims = await verify(ticket.token);
    expect(claims.sub).toBe('p84-01234567-P0');
    expect(claims.video).toStrictEqual({ ...PUBLISHER_GRANT, canPublishSources: ['microphone'] });
  });

  it.each<TicketRole>(['listener', 'publisher'])(
    '%s ticket: no room-creating/admin grant and no claim beyond video/iss/sub/nbf/exp',
    async (role) => {
      const { token } = await mintScopedTicket(ENV, { identity: `id-${role}`, room: ROOM, role });
      const claims = await verify(token);
      for (const name of FORBIDDEN) expect(claims.video).not.toHaveProperty(name);
      expect(Object.keys(claims).sort()).toEqual(['exp', 'iss', 'nbf', 'sub', 'video']);
    },
  );

  it('lives FLEET_TICKET_TTL_SECONDS: exp − nbf ≈ 300 s and exp ≈ now + 300 s', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { token } = await mintScopedTicket(ENV, {
      identity: 'ttl',
      room: ROOM,
      role: 'listener',
    });
    const after = Math.ceil(Date.now() / 1000);
    const claims = await verify(token);
    const exp = claims.exp!;
    const nbf = claims.nbf!;
    expect(Math.abs(exp - nbf - FLEET_TICKET_TTL_SECONDS)).toBeLessThanOrEqual(1);
    expect(nbf).toBeGreaterThanOrEqual(before);
    expect(nbf).toBeLessThanOrEqual(after);
    expect(exp).toBeGreaterThanOrEqual(before + FLEET_TICKET_TTL_SECONDS);
    expect(exp).toBeLessThanOrEqual(after + FLEET_TICKET_TTL_SECONDS);
    // The SDK sets nbf, not iat (claim set asserted above), so nbf is the issue time.
    expect(claims.iat).toBeUndefined();
  });

  it('is signed with the env secret and issued by the env key (other key/secret rejected)', async () => {
    const { token } = await mintScopedTicket(ENV, {
      identity: 'sig',
      room: ROOM,
      role: 'listener',
    });
    await expect(
      verify(token, ENV.apiKey, 'another-secret-long-enough-for-hs256!!'),
    ).rejects.toThrow();
    await expect(verify(token, 'APIanotherkey', ENV.apiSecret)).rejects.toThrow();
    expect(token).not.toContain(ENV.apiSecret);
  });

  it('one identity per ticket: distinct identities give distinct subs in the same room', async () => {
    const [a, b] = await Promise.all(
      ['p84-r-L00000', 'p84-r-L00001'].map((identity) =>
        mintScopedTicket(ENV, { identity, room: ROOM, role: 'listener' }).then((t) =>
          verify(t.token),
        ),
      ),
    );
    expect([a.sub, b.sub]).toEqual(['p84-r-L00000', 'p84-r-L00001']);
    expect([a.video?.room, b.video?.room]).toEqual([ROOM, ROOM]);
  });
});

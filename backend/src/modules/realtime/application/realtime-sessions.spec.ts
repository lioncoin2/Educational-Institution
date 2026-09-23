import { Logger } from '@nestjs/common';

import { expectOk } from '../../../../test/support/identity-harness';
import { META } from '../../../../test/support/messaging-harness';
import {
  realtimeHarness,
  type Client,
  type RealtimeHarness,
} from '../../../../test/support/realtime-harness';
import { Roles } from '../../identity/domain/role';
import { CloseCodes } from '../domain/protocol';
import {
  CONNECTIONS_OPENED_PER_USER,
  FRAMES_PER_CONNECTION,
  RealtimeLimits,
} from '../domain/realtime-policy';

const errorOf = (client: Client) => client.link.ofType('error').at(-1);

describe('realtime sessions', () => {
  let h: RealtimeHarness;
  beforeEach(async () => {
    h = await realtimeHarness();
  });
  afterEach(() => h.cleanup());

  describe('authenticating a connection', () => {
    it('authenticates with the access token identity issued — the server says who, and until when', async () => {
      const student = await h.person(Roles.student);
      const client = await h.connect(student.accessToken);

      expect(client.link.frames).toEqual([
        {
          type: 'ready',
          version: 1,
          connectionId: client.connectionId,
          userId: student.userId,
          expiresAt: new Date(h.clock.now().getTime() + 900_000).toISOString(),
          heartbeatSeconds: RealtimeLimits.heartbeatSeconds,
        },
      ]);
      expect(h.connections.get(client.connectionId)).toMatchObject({
        userId: student.userId,
        sessionId: student.sessionId,
      });
      expect(client.link.closed).toBeNull();
    });

    it.each([
      ['garbage', 'not-a-token'],
      ['a token signed by someone else', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.Zm9yZ2Vk'],
    ])('refuses %s: UNAUTHORIZED, closed, never registered', async (_what, token) => {
      const client = await h.connect(token);

      expect(errorOf(client)).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(client.link.closed?.code).toBe(CloseCodes.unauthorized);
      expect(h.connections.count()).toBe(0);
    });

    it('refuses an expired token', async () => {
      const student = await h.person(Roles.student);
      h.clock.advance(901);
      const client = await h.connect(student.accessToken);

      expect(errorOf(client)).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(client.link.closed?.code).toBe(CloseCodes.unauthorized);
      expect(h.connections.count()).toBe(0);
    });

    it('refuses a token whose session was revoked (signed out) while the token still lives', async () => {
      const student = await h.person(Roles.student);
      const principal = await h.identity.resolvePrincipal.execute(student.accessToken);
      expectOk(await h.identity.logout.execute({ principal: principal!, meta: META }));

      const client = await h.connect(student.accessToken);

      expect(errorOf(client)).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(h.connections.count()).toBe(0);
    });

    it('refuses a suspended account', async () => {
      const student = await h.person(Roles.student);
      await h.identity.users.save({
        ...(await h.identity.userById(student.userId)),
        status: 'SUSPENDED',
      });
      const client = await h.connect(student.accessToken);
      expect(errorOf(client)).toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('refuses, as FORBIDDEN, an account that may not read messages', async () => {
      const nobody = await h.person(null);
      const client = await h.connect(nobody.accessToken);

      expect(errorOf(client)).toMatchObject({ code: 'FORBIDDEN' });
      expect(client.link.closed?.code).toBe(CloseCodes.forbidden);
      expect(h.connections.count()).toBe(0);
    });

    it('does not take a user id from the client — a frame claiming one is refused', async () => {
      const student = await h.person(Roles.student);
      const owner = await h.person(Roles.owner);
      const client = await h.connect();
      await client.send({ type: 'auth', token: student.accessToken, userId: owner.userId });

      expect(errorOf(client)).toMatchObject({ code: 'INVALID_PAYLOAD' });
      expect(h.connections.count()).toBe(0);
    });

    it('closes a connection that never authenticates, at the deadline', async () => {
      const client = await h.connect();
      h.clock.advance(RealtimeLimits.authDeadlineSeconds - 1);
      await h.sessions.sweep();
      expect(client.link.closed).toBeNull();

      h.clock.advance(1);
      await h.sessions.sweep();
      expect(errorOf(client)).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Authentication timed out.',
      });
      expect(client.link.closed?.code).toBe(CloseCodes.unauthorized);
      expect(h.sessions.pendingCount()).toBe(0);
    });

    it('will not subscribe a connection before it has authenticated', async () => {
      const client = await h.connect();
      await client.send({ type: 'subscribe', conversationId: 'anything', id: 's1' });
      expect(errorOf(client)).toMatchObject({ code: 'UNAUTHORIZED', id: 's1' });
      expect(client.link.ofType('subscribed')).toEqual([]);
    });
  });

  describe('keeping a connection authenticated', () => {
    it('closes a connection when its token expires', async () => {
      const student = await h.person(Roles.student);
      const client = await h.connect(student.accessToken);
      h.clock.advance(900);
      await h.sessions.sweep();

      expect(errorOf(client)).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'The access token has expired.',
      });
      expect(client.link.closed?.code).toBe(CloseCodes.unauthorized);
      expect(h.connections.isOnline(student.userId)).toBe(false);
    });

    it('stays open when re-authenticated with a fresh token before expiry', async () => {
      const student = await h.person(Roles.student);
      const client = await h.connect(student.accessToken);
      h.clock.advance(800);
      const renewed = expectOk(
        await h.identity.refresh.execute({ refreshToken: student.refreshToken, meta: META }),
      );
      await client.send({ type: 'auth', token: renewed.accessToken, id: 're' });

      expect(client.link.ofType('ready')).toHaveLength(2);
      expect(client.link.last()).toMatchObject({
        type: 'ready',
        id: 're',
        connectionId: client.connectionId,
      });
      h.clock.advance(200); // past the first token's expiry
      await h.sessions.sweep();
      expect(client.link.closed).toBeNull();
      expect(h.connections.isOnline(student.userId)).toBe(true);
    });

    it("refuses re-authentication as someone else — a connection's account never changes", async () => {
      const student = await h.person(Roles.student);
      const teacher = await h.person(Roles.teacher);
      const client = await h.connect(student.accessToken);
      await client.send({ type: 'auth', token: teacher.accessToken });

      expect(errorOf(client)).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(client.link.closed?.code).toBe(CloseCodes.unauthorized);
      expect(h.connections.count()).toBe(0);
    });

    it('closes an open connection whose session is revoked, at the next revalidation', async () => {
      const student = await h.person(Roles.student);
      const client = await h.connect(student.accessToken);
      const principal = await h.identity.resolvePrincipal.execute(student.accessToken);
      expectOk(await h.identity.logout.execute({ principal: principal!, meta: META }));

      await h.sessions.sweep(); // not due yet
      expect(client.link.closed).toBeNull();
      h.clock.advance(RealtimeLimits.revalidateSeconds);
      await h.sessions.sweep();

      expect(errorOf(client)).toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'The session has ended.',
      });
      expect(client.link.closed?.code).toBe(CloseCodes.unauthorized);
      expect(h.connections.count()).toBe(0);
    });

    it('closes, as FORBIDDEN, a connection whose account lost messaging at revalidation', async () => {
      await h.identity.seedUser({ email: 'boss@institution.test', roles: ['OWNER'] });
      const actor = await h.identity.principalOf('boss@institution.test');
      const teacher = await h.person(Roles.teacher);
      const client = await h.connect(teacher.accessToken);
      expectOk(
        await h.identity.revokeRole.execute({
          actor,
          userId: teacher.userId,
          role: 'TEACHER',
          meta: META,
        }),
      );
      h.clock.advance(RealtimeLimits.revalidateSeconds);
      await h.sessions.sweep();

      expect(errorOf(client)).toMatchObject({ code: 'FORBIDDEN' });
      expect(client.link.closed?.code).toBe(CloseCodes.forbidden);
    });

    it('revalidates each session once, however many of its connections are open', async () => {
      const student = await h.person(Roles.student);
      await h.connect(student.accessToken);
      await h.connect(student.accessToken);
      const revalidate = jest.spyOn(h.identity.resolvePrincipal, 'revalidate');
      h.clock.advance(RealtimeLimits.revalidateSeconds);
      await h.sessions.sweep();
      expect(revalidate).toHaveBeenCalledTimes(1);
      expect(h.connections.getUserConnections(student.userId)).toHaveLength(2);
    });
  });

  describe('limits', () => {
    it('accepts several devices per account, up to the limit, then refuses with RATE_LIMITED', async () => {
      const student = await h.person(Roles.student);
      for (let i = 0; i < RealtimeLimits.connectionsPerUser; i++) {
        expect((await h.connect(student.accessToken)).link.closed).toBeNull();
      }
      const extra = await h.connect(student.accessToken);

      expect(errorOf(extra)).toMatchObject({ code: 'RATE_LIMITED' });
      expect(extra.link.closed?.code).toBe(CloseCodes.rateLimited);
      expect(h.connections.getUserConnections(student.userId)).toHaveLength(
        RealtimeLimits.connectionsPerUser,
      );
    });

    it('limits how fast one account opens connections — a client stuck reconnecting', async () => {
      const student = await h.person(Roles.student);
      for (let i = 0; i < CONNECTIONS_OPENED_PER_USER.limit; i++) {
        const client = await h.connect(student.accessToken);
        h.sessions.closed(client.connectionId);
      }
      const extra = await h.connect(student.accessToken);
      expect(errorOf(extra)).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 60 });
    });

    it('closes a connection that floods frames', async () => {
      const student = await h.person(Roles.student);
      const client = await h.connect(student.accessToken); // one frame already
      for (let i = 1; i < FRAMES_PER_CONNECTION.limit; i++) await client.send({ type: 'ping' });
      expect(client.link.closed).toBeNull();

      await client.send({ type: 'ping' });

      expect(errorOf(client)).toMatchObject({ code: 'RATE_LIMITED' });
      expect(client.link.closed?.code).toBe(CloseCodes.rateLimited);
      expect(h.connections.count()).toBe(0);
    });
  });

  describe('frames', () => {
    it('answers a ping with a pong, echoing the id, and notes that it heard the client', async () => {
      const student = await h.person(Roles.student);
      const client = await h.connect(student.accessToken);
      h.clock.advance(30);
      await client.send({ type: 'ping', id: 'hb-1' });

      expect(client.link.last()).toEqual({ type: 'pong', version: 1, id: 'hb-1' });
      expect(h.connections.get(client.connectionId)?.lastSeenAt).toEqual(h.clock.now());
    });

    it('rejects malformed frames with a stable code and keeps the connection', async () => {
      const student = await h.person(Roles.student);
      const client = await h.connect(student.accessToken);

      await h.sessions.received(client.connectionId, '{not json');
      expect(errorOf(client)).toMatchObject({ code: 'INVALID_EVENT' });
      await h.sessions.received(client.connectionId, null);
      expect(errorOf(client)).toMatchObject({ code: 'INVALID_EVENT' });
      await client.send({ type: 'subscribe', conversationId: 42 });
      expect(errorOf(client)).toMatchObject({ code: 'INVALID_PAYLOAD' });

      expect(client.link.closed).toBeNull();
      for (const error of client.link.ofType('error')) {
        expect(Object.keys(error).sort()).toEqual(['code', 'message', 'type', 'version']);
      }
    });

    it('handles one connection’s frames in order', async () => {
      const student = await h.person(Roles.student);
      const client = await h.connect();
      // Sent back to back, without waiting: subscribe must see the auth.
      const auth = h.sessions.received(
        client.connectionId,
        JSON.stringify({ type: 'auth', token: student.accessToken }),
      );
      const ping = h.sessions.received(client.connectionId, JSON.stringify({ type: 'ping' }));
      await Promise.all([auth, ping]);
      expect(client.link.frames.map((frame) => frame.type)).toEqual(['ready', 'pong']);
    });

    it('answers an unexpected failure with SERVER_ERROR and nothing else', async () => {
      const student = await h.person(Roles.student);
      const client = await h.connect(student.accessToken);
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest
        .spyOn(h.messaging.delivery, 'position')
        .mockRejectedValueOnce(new Error('database exploded at /srv/secret/path'));
      await client.send({ type: 'subscribe', conversationId: 'c-1' });

      expect(errorOf(client)).toEqual({
        type: 'error',
        version: 1,
        code: 'SERVER_ERROR',
        message: 'Something went wrong.',
      });
      expect(JSON.stringify(client.link.frames)).not.toContain('secret');
      expect(client.link.closed).toBeNull();
      // The server keeps the detail for itself.
      expect(logged).toHaveBeenCalledTimes(1);
      logged.mockRestore();
    });
  });

  describe('subscribing to a conversation', () => {
    it('confirms a member, with the positions to catch up from', async () => {
      const teacher = await h.person(Roles.teacher);
      const student = await h.person(Roles.student);
      const group = await h.messaging.group(teacher.principal, [student.principal]);
      await h.messaging.text(teacher.principal, group.id, 'one');
      await h.messaging.text(teacher.principal, group.id, 'two');
      const client = await h.connect(student.accessToken);

      await client.send({ type: 'subscribe', conversationId: group.id, id: 'sub-1' });

      expect(client.link.last()).toEqual({
        type: 'subscribed',
        version: 1,
        id: 'sub-1',
        conversationId: group.id,
        lastSequence: 2,
        lastReadSequence: 0,
      });
    });

    it('refuses a conversation the caller is not in exactly like one that does not exist', async () => {
      const teacher = await h.person(Roles.teacher);
      const student = await h.person(Roles.student);
      const stranger = await h.person(Roles.student);
      const group = await h.messaging.group(teacher.principal, [student.principal]);
      const client = await h.connect(stranger.accessToken);

      await client.send({ type: 'subscribe', conversationId: group.id });
      const refusedReal = errorOf(client);
      await client.send({ type: 'subscribe', conversationId: 'does-not-exist' });
      const refusedMissing = errorOf(client);

      expect(refusedReal).toMatchObject({
        code: 'CONVERSATION_NOT_FOUND',
        conversationId: group.id,
      });
      expect({ ...refusedMissing, conversationId: group.id }).toEqual(refusedReal);
      expect(client.link.ofType('subscribed')).toEqual([]);
      expect(client.link.closed).toBeNull();
    });

    it('refuses the institution owner in a conversation they are not in', async () => {
      const teacher = await h.person(Roles.teacher);
      const student = await h.person(Roles.student);
      const owner = await h.person(Roles.owner);
      const dm = await h.messaging.direct(teacher.principal, student.principal);
      const client = await h.connect(owner.accessToken);

      await client.send({ type: 'subscribe', conversationId: dm.id });

      expect(errorOf(client)).toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    });

    it('checks the session afresh: a revoked session cannot subscribe, even before revalidation', async () => {
      const teacher = await h.person(Roles.teacher);
      const student = await h.person(Roles.student);
      const group = await h.messaging.group(teacher.principal, [student.principal]);
      const client = await h.connect(student.accessToken);
      const principal = await h.identity.resolvePrincipal.execute(student.accessToken);
      expectOk(await h.identity.logout.execute({ principal: principal!, meta: META }));

      await client.send({ type: 'subscribe', conversationId: group.id });

      expect(errorOf(client)).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(client.link.closed?.code).toBe(CloseCodes.unauthorized);
      expect(client.link.ofType('subscribed')).toEqual([]);
    });
  });
});

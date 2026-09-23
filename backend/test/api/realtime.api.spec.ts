import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';
import {
  ConversationMirror,
  HandshakeRefused,
  TestSocket,
  type Frame,
  type WireMessage,
} from '../support/realtime-client';

const WEB_ORIGIN = 'https://app.institution.test';

/** Resolves with the refusal status of a handshake that must not succeed. */
async function refusal(open: Promise<TestSocket>): Promise<number> {
  try {
    const socket = await open;
    await socket.close();
  } catch (error) {
    if (error instanceof HandshakeRefused) return error.status;
    throw error;
  }
  throw new Error('the handshake was accepted');
}

const messageOf = (frame: Frame) => frame.message as WireMessage;

/** Polls a condition that settles asynchronously, failing after a bound. */
async function eventually(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Realtime over real sockets: the application exactly as the server runs it
 * (AppModule, configureApp, the HTTP server the WebSocket endpoint shares),
 * in-memory persistence, a `ws` client. Postgres is covered by
 * test/integration/realtime-postgres.spec.ts.
 */
describe('realtime API', () => {
  let r: RealtimeApi;
  let teacher: Account;
  let studentB: Account;
  let studentC: Account;
  let outsider: Account;

  beforeAll(async () => {
    r = await startRealtimeApi({ CORS_ORIGINS: WEB_ORIGIN });
    teacher = await r.provision('teacher', 'TEACHER', 'الأستاذ عبدالله');
    studentB = await r.provision('student-b', 'STUDENT', 'بلال');
    studentC = await r.provision('student-c', 'STUDENT', 'خالد');
    outsider = await r.provision('outsider', 'TEACHER');
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  describe('the endpoint', () => {
    it('is served on /realtime only', async () => {
      expect(await refusal(TestSocket.open(r.wsUrl.replace('/realtime', '/elsewhere')))).toBe(404);
    });

    // CORS does not apply to WebSockets: a page on any site can open one to
    // any server. The handshake's Origin is checked against the same
    // allow-list the HTTP API uses.
    it('refuses a browser page from an origin the API does not serve', async () => {
      expect(await refusal(TestSocket.open(r.wsUrl, { origin: 'https://evil.example' }))).toBe(403);
      const allowed = await TestSocket.open(r.wsUrl, { origin: WEB_ORIGIN });
      await allowed.close();
    });

    it('accepts a native client, which sends no Origin', async () => {
      const socket = await TestSocket.signedIn(r.wsUrl, studentB.token);
      expect(socket.ofType('ready')[0]).toMatchObject({ userId: studentB.id });
      await socket.close();
    });

    it('refuses a bad token with an error frame and close code 4401', async () => {
      const socket = await TestSocket.open(r.wsUrl);
      socket.send({ type: 'auth', token: 'not.a.token' });
      expect((await socket.waitFor((f) => f.type === 'error')).code).toBe('UNAUTHORIZED');
      expect((await socket.waitForClose()).code).toBe(4401);
    });

    it('closes the connection on a frame over the size limit (1009)', async () => {
      const socket = await TestSocket.signedIn(r.wsUrl, studentB.token);
      socket.sendRaw(JSON.stringify({ type: 'ping', padding: 'x'.repeat(5000) }));
      expect((await socket.waitForClose()).code).toBe(1009);
    });

    it('rejects a malformed frame with INVALID_EVENT and keeps the connection', async () => {
      const socket = await TestSocket.signedIn(r.wsUrl, studentB.token);
      socket.sendRaw('{"type":');
      expect((await socket.waitFor((f) => f.type === 'error')).code).toBe('INVALID_EVENT');
      socket.send({ type: 'ping', id: 'still-here' });
      await socket.waitFor((f) => f.type === 'pong' && f.id === 'still-here');
      await socket.close();
    });
  });

  describe('delivery', () => {
    it('delivers a stored message to the other members, as the timeline shows it', async () => {
      const groupId = await r.group(teacher, [studentB, studentC]);
      const b = await r.connect(studentB);
      const t = await r.connect(teacher);

      const stored = await r.send(teacher, groupId, 'السلام عليكم', 'e2e-key-00000001');

      const toB = await b.waitFor((f) => f.type === 'message.sent');
      expect(toB).toMatchObject({ messageId: stored.id, sequence: stored.sequence });
      const [asTimelineShowsIt] = await r.timeline(studentB, groupId);
      expect(messageOf(toB)).toEqual(asTimelineShowsIt);

      // The sender's own device receives exactly what the HTTP send returned.
      const toSender = await t.waitFor((f) => f.type === 'message.sent');
      expect(messageOf(toSender)).toEqual(stored);
      expect(messageOf(toSender).clientMessageId).toBe('e2e-key-00000001');

      await Promise.all([b.close(), t.close()]);
    });

    it('delivers to every device of a member, and stops at a device that disconnects', async () => {
      const groupId = await r.group(teacher, [studentB]);
      const phone = await r.connect(studentB);
      const web = await r.connect(await r.anotherDevice(studentB));

      const first = await r.send(teacher, groupId, 'to both');
      for (const device of [phone, web]) {
        expect((await device.waitFor((f) => f.type === 'message.sent')).messageId).toBe(first.id);
      }

      await phone.close();
      const second = await r.send(teacher, groupId, 'to the web only');
      await web.waitFor((f) => f.type === 'message.sent' && f.messageId === second.id);
      expect(phone.ofType('message.sent').map((f) => f.messageId)).toEqual([first.id]);
      await web.close();
    });

    it('recovers what was sent while disconnected — by sequence, over HTTP', async () => {
      const groupId = await r.group(teacher, [studentB]);
      const mirror = new ConversationMirror(groupId, (after) =>
        r.messagesAfter(studentB, groupId, after),
      );
      const b1 = await r.connect(studentB);
      await r.send(teacher, groupId, 'one');
      mirror.receive(await b1.waitFor((f) => f.type === 'message.sent'));
      expect(mirror.contiguousThrough).toBe(1);

      b1.kill(); // the network drops
      for (const body of ['two', 'three', 'four']) await r.send(teacher, groupId, body);

      const b2 = await r.connect(studentB);
      b2.send({ type: 'subscribe', conversationId: groupId, id: 'resync' });
      const position = await b2.waitFor((f) => f.type === 'subscribed');
      expect(position).toMatchObject({ lastSequence: 4 });
      expect(position.lastSequence).toBeGreaterThan(mirror.contiguousThrough);
      await mirror.catchUp();

      expect(mirror.messages.map((m) => [m.sequence, m.body])).toEqual([
        [1, 'one'],
        [2, 'two'],
        [3, 'three'],
        [4, 'four'],
      ]);
      expect(mirror.catchUps[0]).toBe(1);

      // And realtime carries on from there.
      await r.send(teacher, groupId, 'five');
      expect(mirror.receive(await b2.waitFor((f) => f.type === 'message.sent'))).toBe('merged');
      expect(mirror.contiguousThrough).toBe(5);
      await b2.close();
    });

    it('fills a gap over HTTP instead of treating the next message as contiguous', async () => {
      const groupId = await r.group(teacher, [studentB]);
      const mirror = new ConversationMirror(groupId, (after) =>
        r.messagesAfter(studentB, groupId, after),
      );
      const b = await r.connect(studentB);
      const sent: WireMessage[] = [];
      for (const body of ['N-1', 'N', 'N+1']) sent.push(await r.send(teacher, groupId, body));
      const frames = await b.waitForCount('message.sent', 3);

      // Event N is lost on the way.
      expect(mirror.receive(frames[0])).toBe('merged');
      expect(mirror.receive(frames[2])).toBe('gap');
      expect(mirror.contiguousThrough).toBe(1);

      await mirror.catchUp();

      expect(mirror.catchUps).toEqual([1]);
      expect(mirror.messages.map((m) => m.body)).toEqual(['N-1', 'N', 'N+1']);
      expect(mirror.contiguousThrough).toBe(3);
      // The late copy of N changes nothing.
      expect(mirror.receive(frames[1])).toBe('duplicate');
      expect(mirror.messages).toHaveLength(3);
      await b.close();
    });
  });

  describe('isolation', () => {
    it('lets nobody subscribe to, or receive, a conversation they are not in', async () => {
      const groupId = await r.group(teacher, [studentB, studentC]);
      const stranger = await r.connect(outsider);
      const owner = await r.connect(r.owner);
      const c = await r.connect(studentC);

      for (const socket of [stranger, owner]) {
        socket.send({ type: 'subscribe', conversationId: groupId, id: 'guess' });
        expect(await socket.waitFor((f) => f.type === 'error' && f.id === 'guess')).toMatchObject({
          code: 'CONVERSATION_NOT_FOUND',
        });
      }
      const sent = await r.send(teacher, groupId, 'for members only');
      // Barrier: once a member has it, the fan-out for this message is over.
      await c.waitFor((f) => f.type === 'message.sent' && f.messageId === sent.id);
      await r.relay.idle();

      for (const socket of [stranger, owner]) {
        expect(socket.ofType('message.sent')).toEqual([]);
        expect(socket.ofType('subscribed')).toEqual([]);
      }
      await Promise.all([stranger.close(), owner.close(), c.close()]);
    });

    it('tells a removed member once, then sends them nothing more of it', async () => {
      const groupId = await r.group(teacher, [studentB, studentC]);
      const b = await r.connect(studentB);
      const c = await r.connect(studentC);

      await r.removeMember(teacher, groupId, studentB.id);
      expect(await b.waitFor((f) => f.type === 'participant.removed')).toMatchObject({
        conversationId: groupId,
        userId: studentB.id,
        reason: 'removed',
      });
      const after = await r.send(teacher, groupId, 'after the removal');
      await c.waitFor((f) => f.type === 'message.sent' && f.messageId === after.id);
      await r.relay.idle();

      expect(b.ofType('message.sent')).toEqual([]);
      b.send({ type: 'subscribe', conversationId: groupId, id: 'again' });
      expect((await b.waitFor((f) => f.id === 'again')).code).toBe('CONVERSATION_NOT_FOUND');
      await Promise.all([b.close(), c.close()]);
    });

    it('closes a connection whose session was signed out, the next time it asks for anything', async () => {
      const device = await r.anotherDevice(studentC);
      const socket = await r.connect(device);
      const logout = await r.api.call('POST', '/auth/logout', { token: device.token });
      expect(logout.status).toBe(204);

      socket.send({ type: 'subscribe', conversationId: 'any-conversation' });
      expect((await socket.waitFor((f) => f.type === 'error')).code).toBe('UNAUTHORIZED');
      expect((await socket.waitForClose()).code).toBe(4401);
    });
  });

  describe('liveness', () => {
    it('drops a connection that stops answering heartbeats, and keeps one that answers', async () => {
      const silent = await TestSocket.open(r.wsUrl, { autoPong: false });
      silent.send({ type: 'auth', token: studentB.token });
      await silent.waitFor((f) => f.type === 'ready');
      const live = await r.connect(studentB);
      const before = r.transport.openSockets();

      r.transport.beat(); // ping
      await new Promise((resolve) => setTimeout(resolve, 100)); // the live one answers
      r.transport.beat(); // the silent one never did

      expect((await silent.waitForClose()).code).toBe(1006); // cut, not closed
      expect(live.closed).toBeNull();
      // The server forgets it as soon as its own side of the socket is gone.
      await eventually(() => r.transport.openSockets() === before - 1);
      await live.close();
    });
  });
});

describe('realtime API shutdown', () => {
  it('closes every connection with 1001 when the server stops', async () => {
    const r = await startRealtimeApi();
    const student = await r.provision('shutdown-student', 'STUDENT');
    const socket = await r.connect(student);

    await r.close();

    expect((await socket.waitForClose()).code).toBe(1001);
  }, 60_000);
});

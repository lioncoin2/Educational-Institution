import { sql } from 'drizzle-orm';

import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';
import { ConversationMirror, type Frame, type TestSocket } from '../support/realtime-client';

/**
 * The whole path on the real stack:
 *
 *   PostgreSQL → messaging.message.sent → realtime relay → recipients (current
 *   membership, read from Postgres) → connection manager → WebSocket → a client
 *   that reconciles by sequence and catches up over HTTP.
 *
 * The application is the production AppModule booted against a freshly
 * migrated database; the clients are real WebSocket connections.
 */
describeWithPostgres('realtime messaging on Postgres, end to end', () => {
  let scratch: ScratchDatabase;
  let r: RealtimeApi;
  let a: Account; // the teacher
  let b: Account; // a student in X
  let c: Account; // a student in another conversation only
  let x: string;
  let y: string;

  const rows = async <T>(query: ReturnType<typeof sql>) =>
    (await scratch.db.execute(query)).rows as T[];

  /** Everything published so far has been delivered (or found no one to deliver to). */
  const settled = () => r.relay.idle();

  beforeAll(async () => {
    scratch = await scratchDatabase();
    r = await startRealtimeApi({ DATABASE_URL: scratch.url });
    a = await r.provision('pg-teacher', 'TEACHER', 'الأستاذ');
    b = await r.provision('pg-student-b', 'STUDENT', 'بلال');
    c = await r.provision('pg-student-c', 'STUDENT', 'خالد');
    x = await r.group(a, [b], 'X');
    y = await r.group(a, [c], 'Y');
  }, 120_000);

  afterAll(async () => {
    await r?.close();
    await scratch?.drop();
  });

  it('runs the whole scenario: deliver, drop, catch up, remove, isolate', async () => {
    const mirror = new ConversationMirror(x, (after) => r.messagesAfter(b, x, after));
    const aSocket = await r.connect(a);
    let bSocket: TestSocket = await r.connect(b);
    const cSocket = await r.connect(c);

    // ── A sends; B receives it, once, with the stored id and sequence ──────
    const first = await r.send(a, x, 'السلام عليكم');
    const [stored] = await rows<{ id: string; sequence: string | number; body: string }>(
      sql`select id, sequence, body from messages where conversation_id = ${x}`,
    );
    expect(stored).toMatchObject({ id: first.id, body: 'السلام عليكم' });
    expect(Number(stored?.sequence)).toBe(1);

    const received = await bSocket.waitFor((f) => f.type === 'message.sent');
    expect(received).toMatchObject({ conversationId: x, messageId: first.id, sequence: 1 });
    expect(mirror.receive(received)).toBe('merged');
    expect(mirror.receive(received)).toBe('duplicate'); // the same event again changes nothing
    expect(mirror.messages.map((m) => m.id)).toEqual([first.id]);

    // ── B drops off; A sends 2, 3, 4; B comes back and catches up ─────────
    bSocket.kill();
    for (const body of ['two', 'three', 'four']) await r.send(a, x, body);
    bSocket = await r.connect(b);
    bSocket.send({ type: 'subscribe', conversationId: x, id: 'resync' });
    expect(await bSocket.waitFor((f) => f.type === 'subscribed')).toMatchObject({
      conversationId: x,
      lastSequence: 4,
    });
    await mirror.catchUp();
    expect(mirror.messages.map((m) => [m.sequence, m.body])).toEqual([
      [1, 'السلام عليكم'],
      [2, 'two'],
      [3, 'three'],
      [4, 'four'],
    ]);
    expect(mirror.catchUps[0]).toBe(1);

    // ── B is removed; A sends 5; B receives nothing of it ─────────────────
    await r.removeMember(a, x, b.id);
    await bSocket.waitFor((f) => f.type === 'participant.removed' && f.conversationId === x);
    const fifth = await r.send(a, x, 'five');
    // Barrier: the sender's own device has message 5, so its fan-out ran.
    await aSocket.waitFor((f) => f.type === 'message.sent' && f.messageId === fifth.id);
    await settled();
    expect(bSocket.ofType('message.sent')).toEqual([]);

    // ── C, in another conversation, never saw anything of X ───────────────
    expect(cSocket.frames.filter((f: Frame) => f.conversationId === x)).toEqual([]);
    // …though C's connection works: a message in Y reaches C, and not B.
    const inY = await r.send(a, y, 'for Y');
    await cSocket.waitFor((f) => f.type === 'message.sent' && f.messageId === inY.id);
    await settled();
    expect(bSocket.ofType('message.sent')).toEqual([]);

    await Promise.all([aSocket.close(), bSocket.close(), cSocket.close()]);
  });

  it('delivers to each of a member’s devices, and only to the ones still connected', async () => {
    const z = await r.group(a, [c], 'Z');
    const device1 = await r.connect(c);
    const device2 = await r.connect(await r.anotherDevice(c));

    const both = await r.send(a, z, 'to both devices');
    for (const device of [device1, device2]) {
      await device.waitFor((f) => f.type === 'message.sent' && f.messageId === both.id);
    }
    await device1.close();
    const one = await r.send(a, z, 'to device 2 only');
    await device2.waitFor((f) => f.type === 'message.sent' && f.messageId === one.id);
    await settled();

    expect(device1.ofType('message.sent').map((f) => f.messageId)).toEqual([both.id]);
    expect(device2.ofType('message.sent').map((f) => f.messageId)).toEqual([both.id, one.id]);
    await device2.close();
  });

  it('fills a lost event from Postgres: N-1, N, N+1 in order, each once', async () => {
    const w = await r.group(a, [c], 'W');
    const mirror = new ConversationMirror(w, (after) => r.messagesAfter(c, w, after));
    const socket = await r.connect(c);
    for (const body of ['N-1', 'N', 'N+1']) await r.send(a, w, body);
    const [before, lost, after] = await socket.waitForCount('message.sent', 3);

    expect(mirror.receive(before)).toBe('merged');
    expect(mirror.receive(after)).toBe('gap'); // not accepted as contiguous
    await mirror.catchUp(); // asks Postgres for what follows N-1
    expect(mirror.catchUps).toEqual([1]);
    expect(mirror.receive(lost)).toBe('duplicate');
    expect(mirror.messages.map((m) => m.body)).toEqual(['N-1', 'N', 'N+1']);
    await socket.close();
  });

  it('never lets anyone follow or receive a conversation they are not in — the owner included', async () => {
    const privateDm = await r.api.call('POST', '/messaging/conversations/direct', {
      token: a.token,
      body: { userId: b.id },
    });
    expect(privateDm.status).toBe(201);
    const dm = privateDm.body as { id: string };
    const owner = await r.connect(r.owner);
    const stranger = await r.connect(c);

    for (const socket of [owner, stranger]) {
      socket.send({ type: 'subscribe', conversationId: dm.id, id: 'probe' });
      expect(await socket.waitFor((f) => f.id === 'probe')).toMatchObject({
        type: 'error',
        code: 'CONVERSATION_NOT_FOUND',
      });
    }
    const aSocket = await r.connect(a);
    const secret = await r.send(a, dm.id, 'between the two of us');
    await aSocket.waitFor((f) => f.type === 'message.sent' && f.messageId === secret.id);
    await settled();

    for (const socket of [owner, stranger]) {
      expect(socket.frames.filter((f) => f.conversationId === dm.id && f.type !== 'error')).toEqual(
        [],
      );
    }
    await Promise.all([owner.close(), stranger.close(), aSocket.close()]);
  });
});

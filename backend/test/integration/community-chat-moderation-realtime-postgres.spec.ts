import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

/**
 * The cross-client DELETE hint on the real stack, end to end:
 *
 *   community chat (a CHANNEL conversation) → a moderator deletes a message over
 *   HTTP → messaging.message.deleted → realtime relay → the recipients Postgres
 *   says are current members → WebSocket → a connected member's client.
 *
 * `message.sent` delivery is already proven by `realtime-postgres.spec`; the
 * DELETE hint is the one message event the Flutter client consumes
 * (`MessageDeletedEvent`) that nothing exercised end to end. Message moderation
 * is a community-chat operation only (ADR 0029): `DELETE
 * /messaging/conversations/:id/messages/:messageId` reaches a DM/group with the
 * same 404 a non-member hears, requires `community.messages.moderate` (the owner
 * implicitly, or a delegated moderator — never a plain member), and raises a
 * frame carrying IDS ONLY (no body, no actor).
 *
 * This asserts the exact frame the client parses — `{ version:1, type:
 * 'message.deleted', eventId, occurredAt, conversationId, messageId, sequence }`,
 * content-free — and the authority policy (a plain member cannot delete; the
 * message stays live for everyone). Booted against a fresh scratch database,
 * with real WebSocket clients; isolated per run and dropped afterwards. It uses
 * no pre-existing server and no shared data.
 */
describeWithPostgres(
  'community-chat moderation over realtime (message.deleted, HTTP → PG → WS)',
  () => {
    let scratch: ScratchDatabase;
    let r: RealtimeApi;
    let student: Account; // a plain community member — no moderation authority
    let communityId: string;
    let chatId: string;

    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const errorOf = (body: Record<string, unknown>) => body.error as { code: string } | undefined;

    /**
     * Opens the community's chat (materializing it) and waits for its member
     * projection — fed asynchronously from community membership by the sweeper —
     * to reach `expected`, so a message posted afterwards actually fans out to the
     * member. Returns the CHANNEL conversation id.
     */
    async function openChatWithMembers(expected: number): Promise<string> {
      for (let attempt = 0; attempt < 50; attempt++) {
        const res = await r.api.call('GET', `/messaging/communities/${communityId}/conversation`, {
          token: r.owner.token,
        });
        expect(res.status).toBe(200);
        if ((res.body.memberCount as number) >= expected) return res.body.id as string;
        await delay(100);
      }
      throw new Error('the community chat projection did not converge to the expected membership');
    }

    beforeAll(async () => {
      scratch = await scratchDatabase();
      r = await startRealtimeApi({ DATABASE_URL: scratch.url });
      student = await r.provision('pg-chat-student', 'STUDENT', 'طالب الحلقة');
      communityId = await r.createCommunity(r.owner, 'حلقة التجويد');
      await r.addToCommunity(r.owner, communityId, [student]);
      chatId = await openChatWithMembers(2); // the owner (creator) + the student
    }, 120_000);

    afterAll(async () => {
      await r?.close();
      await scratch?.drop();
    });

    it('delivers a content-free message.deleted frame to a member when a moderator deletes', async () => {
      const socket = await r.connect(student);
      socket.send({ type: 'subscribe', conversationId: chatId, id: 'sub' });
      await socket.waitFor((f) => f.type === 'subscribed' && f.conversationId === chatId);

      // The moderator (the community owner) posts; the member receives it live.
      const message = await r.send(r.owner, chatId, 'رسالة ستُحذف');
      const sent = await socket.waitFor(
        (f) => f.type === 'message.sent' && f.messageId === message.id,
      );
      expect(sent).toMatchObject({ conversationId: chatId, sequence: message.sequence });

      // The moderator deletes it over the ordinary conversation route (204).
      const deletion = await r.api.call(
        'DELETE',
        `/messaging/conversations/${chatId}/messages/${message.id}`,
        { token: r.owner.token },
      );
      expect(deletion.status).toBe(204);

      // The member's client receives exactly the shape MessageDeletedEvent parses.
      const deleted = await socket.waitFor(
        (f) => f.type === 'message.deleted' && f.messageId === message.id,
      );
      expect(deleted).toMatchObject({
        version: 1,
        type: 'message.deleted',
        conversationId: chatId,
        messageId: message.id,
        sequence: message.sequence,
      });
      expect(typeof deleted.eventId).toBe('string');
      expect(typeof deleted.occurredAt).toBe('string');
      // Content-free: no body, no actor, no nested message leak.
      expect(deleted).not.toHaveProperty('body');
      expect(deleted).not.toHaveProperty('message');
      expect(deleted).not.toHaveProperty('deletedBy');

      await socket.close();
    }, 30_000);

    it('refuses a plain member’s delete and leaves the message live for everyone', async () => {
      const message = await r.send(r.owner, chatId, 'رسالة لا تُحذف');

      // The student is a member, but holds no community.messages.moderate.
      const attempt = await r.api.call(
        'DELETE',
        `/messaging/conversations/${chatId}/messages/${message.id}`,
        { token: student.token },
      );
      expect(attempt.status).toBe(403);
      // The moderation permit is refused with its own specific code (ADR 0029) —
      // not the generic identity denial — so a member learns only that they may
      // not moderate, never anything about the community's authority model.
      expect(errorOf(attempt.body)?.code).toBe('messaging.message_moderation_forbidden');

      // It stays live — not a tombstone — in the member's own timeline.
      const timeline = await r.timeline(student, chatId);
      const still = timeline.find((m) => m.id === message.id);
      expect(still).toBeDefined();
      expect(still?.deletedAt ?? null).toBeNull();
      expect(still?.body).toBe('رسالة لا تُحذف');
    }, 30_000);
  },
);

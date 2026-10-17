import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

/**
 * The community-chat POSTING contract (Q51), end to end over REAL PostgreSQL and
 * the exact HTTP routes the Flutter app drives — the runtime guard for the
 * "members read, owner/granted-posters post" policy the app surfaces as the
 * locked composer (`conversation.canPost` → `MessagingCopy.cannotPostHere`).
 *
 *   owner creates a community → adds a plain member and a second member →
 *   grants ONLY the second member `community.chat.post` → the chat is opened
 *   (materialized as a CHANNEL conversation) and its membership projection
 *   converges, then:
 *
 *     • the OWNER (implicit holder) reads `canPost:true` and a post lands (201);
 *     • a PLAIN member reads `canPost:false` and a post is refused 403
 *       `messaging.posting_not_allowed` — yet the member can still READ the
 *       channel (reading is `community.chat.read`, satisfied by membership);
 *     • the GRANTED member reads `canPost:true` and a post lands and persists;
 *     • a NON-member can neither read the conversation nor its messages nor post
 *       — the channel never leaks to someone outside the community.
 *
 * It asserts the response FIELDS the client reads (`canPost` on the conversation,
 * the forbidden error CODE, the persisted message in the timeline), not HTTP
 * status alone. `community-chat.spec` proves the same policy at the use-case
 * layer in-memory; this proves the Communities capability authority, the Drizzle
 * persistence and the HTTP serialization agree with it on a real database — the
 * way `messaging-attachments-postgres` backs `messaging.api.spec`.
 *
 * It ENCODES the current Q51 policy; it does not change it. If the policy were
 * weakened so a plain member could post, the `canPost:false` / 403 assertions
 * here would fail — which is the point of a permanent guard. Booted against a
 * fresh scratch database, isolated per run and dropped afterwards; no
 * pre-existing server, no shared data, no production/staging secret.
 */
describeWithPostgres(
  'community-chat posting contract over PostgreSQL (Q51: members read, owner/grant post)',
  () => {
    let scratch: ScratchDatabase;
    let r: RealtimeApi;

    let member: Account; // an ACTIVE community member with NO grant — reader only
    // An ACTIVE member who is ELIGIBLE to hold community.chat.post (its ceiling is
    // communities.moderate + messaging.send — a STUDENT lacks communities.moderate,
    // so the grantee is a TEACHER) and is then explicitly granted it.
    let poster: Account;
    let outsider: Account; // never added to the community
    let communityId: string;
    let chatId: string;

    const OWNER_LINE = 'رسالة من المالك';
    const POSTER_LINE = 'رسالة من العضو الممنوح';

    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const errorOf = (body: Record<string, unknown>) => body.error as { code: string } | undefined;

    /**
     * Opens (materializes) the community chat and waits for its member projection
     * — fed asynchronously from community membership — to reach `expected`, so the
     * posting permits resolve against a converged channel. Returns the CHANNEL id.
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

    /** GET the community chat as `who`, returning the parsed ConversationResponse. */
    async function conversationAs(who: Account) {
      return r.api.call('GET', `/messaging/communities/${communityId}/conversation`, {
        token: who.token,
      });
    }

    /** POST a text message as `who` through the ordinary conversation route. */
    async function postAs(who: Account, body: string) {
      return r.api.call('POST', `/messaging/conversations/${chatId}/messages/text`, {
        token: who.token,
        body: { clientMessageId: `cc-post-${Math.random().toString(36).slice(2)}`, body },
      });
    }

    beforeAll(async () => {
      scratch = await scratchDatabase();
      r = await startRealtimeApi({ DATABASE_URL: scratch.url });

      member = await r.provision('cc-post-member', 'STUDENT', 'عضو عادي');
      poster = await r.provision('cc-post-granted', 'TEACHER', 'عضو ممنوح');
      outsider = await r.provision('cc-post-outsider', 'STUDENT', 'غير عضو');

      communityId = await r.createCommunity(r.owner, 'حلقة النشر');
      await r.addToCommunity(r.owner, communityId, [member, poster]);
      // Grant ONLY the second member the posting capability (Q51: explicit grant).
      await r.grantCapabilities(r.owner, communityId, poster.id, ['community.chat.post']);

      chatId = await openChatWithMembers(3); // owner (creator) + member + poster
    }, 120_000);

    afterAll(async () => {
      await r?.close();
      await scratch?.drop();
    });

    it('the OWNER holds community.chat.post implicitly: canPost=true and a post lands', async () => {
      const view = await conversationAs(r.owner);
      expect(view.status).toBe(200);
      expect(view.body.id).toBe(chatId);
      expect(view.body.communityId).toBe(communityId);
      expect(view.body.canPost).toBe(true);

      const posted = await postAs(r.owner, OWNER_LINE);
      expect(posted.status).toBe(201);
      expect(posted.body.body).toBe(OWNER_LINE);
      expect(posted.body.conversationId).toBe(chatId);
    });

    it('a plain member: canPost=false and a post is refused 403 posting_not_allowed', async () => {
      const view = await conversationAs(member);
      expect(view.status).toBe(200);
      expect(view.body.id).toBe(chatId);
      // The exact field the Flutter composer reads to lock itself (Q51).
      expect(view.body.canPost).toBe(false);

      const refused = await postAs(member, 'محاولة من عضو عادي');
      expect(refused.status).toBe(403);
      expect(errorOf(refused.body)?.code).toBe('messaging.posting_not_allowed');
    });

    it('a plain member can still READ the channel (membership satisfies community.chat.read)', async () => {
      // canPost is about writing; reading is open to every ACTIVE member.
      const timeline = await r.api.call(
        'GET',
        `/messaging/conversations/${chatId}/messages?limit=100`,
        { token: member.token },
      );
      expect(timeline.status).toBe(200);
      const items = timeline.body.items as Record<string, unknown>[];
      expect(Array.isArray(items)).toBe(true);
      // The member reads the owner's message posted above — read is unaffected by the post lock.
      expect(items.some((m) => m.body === OWNER_LINE)).toBe(true);
    });

    it('a member granted community.chat.post: canPost=true, the post lands and persists', async () => {
      const view = await conversationAs(poster);
      expect(view.status).toBe(200);
      expect(view.body.canPost).toBe(true);

      const posted = await postAs(poster, POSTER_LINE);
      expect(posted.status).toBe(201);
      expect(posted.body.body).toBe(POSTER_LINE);

      // Persisted to Postgres: the owner reads the granted member's message back.
      const ownerTimeline = await r.timeline(r.owner, chatId);
      expect(ownerTimeline.some((m) => m.body === POSTER_LINE)).toBe(true);
    });

    it('a NON-member cannot read the conversation, read its messages, or post (no leak)', async () => {
      // The chat is hidden exactly as a non-existent one — same 404.
      const view = await conversationAs(outsider);
      expect(view.status).toBe(404);
      expect(errorOf(view.body)?.code).toBe('messaging.conversation_not_found');

      const timeline = await r.api.call(
        'GET',
        `/messaging/conversations/${chatId}/messages?limit=100`,
        { token: outsider.token },
      );
      expect(timeline.status).toBe(404);
      expect(timeline.body).not.toHaveProperty('items');

      const post = await postAs(outsider, 'محاولة من غريب');
      // Never accepted; a non-member is refused (403) or told nothing exists (404).
      expect(post.status).not.toBe(201);
      expect([403, 404]).toContain(post.status);
    });
  },
);

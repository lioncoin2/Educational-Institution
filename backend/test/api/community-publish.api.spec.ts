import { sampleBytes } from '../support/files-harness';
import type { ApiResponse } from '../support/api-client';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';

/**
 * Mass publishing to several communities over HTTP — the application exactly as
 * the server runs it without a database (AppModule, real guards/pipes/filter,
 * the in-memory stores, Communities' events reaching messaging on the real bus).
 *
 * It proves the real data flow the feature rests on, not a double:
 *   - one post fans out to many communities, authorized PER community;
 *   - a viewer reaches only communities they may post in (partial failure is
 *     the normal case, reported per community, never a thrown batch);
 *   - a single uploaded file is published to several communities at once;
 *   - a retry with the same batch id re-posts nothing it already delivered.
 */
describe('mass publish to communities API', () => {
  let r: RealtimeApi;
  let admin: Account;
  let teacher: Account;
  let student: Account;
  let c1: string; // teacher granted community.chat.post here
  let c2: string; // teacher is a member, no grant (a CHANNEL → may not post)
  let c3: string; // admin only; teacher/student are not members
  let batch = 0;

  beforeAll(async () => {
    r = await startRealtimeApi();
    admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    teacher = await r.provision('teacher', 'TEACHER', 'الأستاذة عائشة');
    student = await r.provision('student', 'STUDENT', 'مريم');

    const make = async (title: string) => {
      const created = await call('POST', '/communities', admin, { title, kind: 'CHANNEL' });
      expect(created.status).toBe(201);
      return created.body.id as string;
    };
    c1 = await make('حلقة التجويد');
    c2 = await make('حلقة الحفظ');
    c3 = await make('حلقة الإدارة');

    for (const id of [c1, c2]) {
      const added = await call('POST', `/communities/${id}/members`, admin, {
        userIds: [teacher.id, student.id],
      });
      expect(added.status).toBe(201);
    }
    const granted = await call('POST', `/communities/${c1}/grants`, admin, {
      userId: teacher.id,
      capabilities: ['community.chat.post'],
    });
    expect(granted.status).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await r.close();
  });

  function call(
    method: string,
    path: string,
    account?: Account,
    body?: unknown,
  ): Promise<ApiResponse> {
    return r.api.call(method, path, { token: account?.token, body });
  }

  const code = (response: ApiResponse) =>
    (response.body.error as Record<string, unknown> | undefined)?.code;

  const nextBatch = () => `pub-${(batch += 1).toString().padStart(4, '0')}`;

  const publish = (account: Account | undefined, body: unknown) =>
    call('POST', '/messaging/communities/publish', account, body);

  type Outcome = {
    communityId: string;
    status: string;
    retryable: boolean;
    messageId: string | null;
  };
  const outcomes = (response: ApiResponse): Record<string, Outcome> =>
    Object.fromEntries((response.body.results as Outcome[]).map((o) => [o.communityId, o]));

  async function messageBodies(account: Account, communityId: string): Promise<string[]> {
    const chat = await call('GET', `/messaging/communities/${communityId}/conversation`, account);
    expect(chat.status).toBe(200);
    const page = await call(
      'GET',
      `/messaging/conversations/${chat.body.id as string}/messages`,
      account,
    );
    expect(page.status).toBe(200);
    return (page.body.items as { body: string | null }[]).map((m) => m.body ?? '');
  }

  it('refuses an anonymous caller (401)', async () => {
    const response = await publish(undefined, {
      clientBatchId: nextBatch(),
      communityIds: [c1],
      kind: 'TEXT',
      body: 'مرحبا',
    });
    expect(response.status).toBe(401);
  });

  it('publishes one text notice to every community the owner may post in', async () => {
    const response = await publish(admin, {
      clientBatchId: nextBatch(),
      communityIds: [c1, c2, c3],
      kind: 'TEXT',
      body: 'تذكير: درس الغد بعد المغرب',
    });
    expect(response.status).toBe(201);
    expect(response.body.summary).toEqual({ total: 3, posted: 3, failed: 0 });
    const byId = outcomes(response);
    for (const id of [c1, c2, c3]) {
      expect(byId[id].status).toBe('posted');
      expect(byId[id].retryable).toBe(false);
      expect(typeof byId[id].messageId).toBe('string');
    }
    expect(await messageBodies(admin, c3)).toContain('تذكير: درس الغد بعد المغرب');
  });

  it('authorizes each community on its own: posts where allowed, reports the rest (partial failure)', async () => {
    const response = await publish(teacher, {
      clientBatchId: nextBatch(),
      communityIds: [c1, c2, 'no-such-community'],
      kind: 'TEXT',
      body: 'أحسنتم جميعا',
    });
    expect(response.status).toBe(201);
    const byId = outcomes(response);
    // c1: teacher holds community.chat.post → posted.
    expect(byId[c1].status).toBe('posted');
    // c2: a member of a CHANNEL without the grant → may not post.
    expect({ status: byId[c2].status, retryable: byId[c2].retryable }).toEqual({
      status: 'forbidden',
      retryable: false,
    });
    // An unknown community (or non-membership) is the same answer, and leaks nothing.
    expect({
      status: byId['no-such-community'].status,
      retryable: byId['no-such-community'].retryable,
    }).toEqual({ status: 'not_found', retryable: false });
    expect(response.body.summary).toEqual({ total: 3, posted: 1, failed: 2 });
  });

  it('retrying with the same batch id re-posts nothing it already delivered (idempotent)', async () => {
    const payload = {
      clientBatchId: nextBatch(),
      communityIds: [c1, c2, c3],
      kind: 'TEXT' as const,
      body: 'إعلان مهم: تم تعديل موعد الاختبار',
    };
    const before = await messageBodies(admin, c1);
    const first = await publish(admin, payload);
    expect(first.body.summary).toMatchObject({ posted: 3 });
    expect(outcomes(first)[c1].status).toBe('posted');

    const retry = await publish(admin, payload);
    expect(retry.status).toBe(201);
    expect(retry.body.summary).toEqual({ total: 3, posted: 3, failed: 0 });
    for (const id of [c1, c2, c3]) expect(outcomes(retry)[id].status).toBe('already_posted');

    const after = await messageBodies(admin, c1);
    // Exactly one new message from the batch — the retry added none.
    expect(after.length).toBe(before.length + 1);
    expect(after.filter((b) => b === payload.body).length).toBe(1);
  });

  it('publishes one uploaded image to several communities at once (real upload → fan-out)', async () => {
    const bytes = sampleBytes('image/png', 256);
    const declared = await call('POST', '/files/uploads', admin, {
      kind: 'IMAGE',
      contentType: 'image/png',
      byteSize: bytes.length,
      fileName: 'لوح.png',
    });
    expect(declared.status).toBe(201);
    const assetId = (declared.body.asset as { id: string }).id;
    const uploadUrl = (declared.body.upload as { url: string }).url;
    const put = await fetch(`${r.api.base}${uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });
    expect(put.status).toBe(201);
    expect((await call('POST', `/files/uploads/${assetId}/complete`, admin)).status).toBe(200);

    const response = await publish(admin, {
      clientBatchId: nextBatch(),
      communityIds: [c1, c2],
      kind: 'IMAGE',
      fileAssetId: assetId,
      body: 'لوحة الدرس',
    });
    expect(response.status).toBe(201);
    expect(response.body.summary).toEqual({ total: 2, posted: 2, failed: 0 });

    const chat = await call('GET', `/messaging/communities/${c1}/conversation`, admin);
    const page = await call(
      'GET',
      `/messaging/conversations/${chat.body.id as string}/messages`,
      admin,
    );
    const image = (
      page.body.items as { type: string; attachments: { fileAssetId: string }[] }[]
    ).find((m) => m.type === 'IMAGE');
    expect(image?.attachments[0]?.fileAssetId).toBe(assetId);
  });

  it('publishes an uploaded document and a recipient opens it through a signed link', async () => {
    const bytes = sampleBytes('application/pdf', 512);
    const declared = await call('POST', '/files/uploads', admin, {
      kind: 'DOCUMENT',
      contentType: 'application/pdf',
      byteSize: bytes.length,
      fileName: 'الدرس.pdf',
    });
    expect(declared.status).toBe(201);
    const assetId = (declared.body.asset as { id: string }).id;
    const uploadUrl = (declared.body.upload as { url: string }).url;
    const put = await fetch(`${r.api.base}${uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: bytes,
    });
    expect(put.status).toBe(201);
    expect((await call('POST', `/files/uploads/${assetId}/complete`, admin)).status).toBe(200);

    const response = await publish(admin, {
      clientBatchId: nextBatch(),
      communityIds: [c1, c2],
      kind: 'FILE',
      fileAssetId: assetId,
      body: 'ملف الدرس',
    });
    expect(response.status).toBe(201);
    expect(response.body.summary).toEqual({ total: 2, posted: 2, failed: 0 });

    // A recipient MEMBER (the student) sees the published FILE message and
    // opens it: the server mints a short-lived signed link to that exact
    // attachment — the end-to-end "recipient can open it" the UI relies on.
    const chat = await call('GET', `/messaging/communities/${c1}/conversation`, student);
    expect(chat.status).toBe(200);
    const conversationId = chat.body.id as string;
    const page = await call('GET', `/messaging/conversations/${conversationId}/messages`, student);
    const file = (
      page.body.items as {
        id: string;
        type: string;
        attachments: { fileAssetId: string; contentType: string | null }[];
      }[]
    ).find((m) => m.type === 'FILE');
    expect(file).toBeDefined();
    expect(file!.attachments[0]?.fileAssetId).toBe(assetId);
    expect(file!.attachments[0]?.contentType).toBe('application/pdf');

    const link = await call(
      'GET',
      `/messaging/conversations/${conversationId}/messages/${file!.id}/attachments/${assetId}/link`,
      student,
    );
    expect(link.status).toBe(200);
    expect(typeof link.body.url).toBe('string');
    expect(typeof link.body.expiresAt).toBe('string');
  });

  // Issue 2: a voice recording published to several communities at once. This
  // is the reported-failing case, exercised end-to-end against the real storage
  // adapter (true signed PUT, true magic-byte check at completion — only the
  // metadata store is in memory), so a defect in the upload→complete→fan-out
  // path for VOICE would fail here rather than only in production.
  it('publishes an uploaded voice recording to several communities (webm) — real upload → fan-out', async () => {
    const bytes = sampleBytes('audio/webm', 256);
    const declared = await call('POST', '/files/uploads', admin, {
      kind: 'VOICE',
      contentType: 'audio/webm',
      byteSize: bytes.length,
      fileName: 'رسالة صوتية.webm',
      durationMs: 5000,
    });
    expect(declared.status).toBe(201);
    const assetId = (declared.body.asset as { id: string }).id;
    const uploadUrl = (declared.body.upload as { url: string }).url;
    const put = await fetch(`${r.api.base}${uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-type': 'audio/webm' },
      body: bytes,
    });
    expect(put.status).toBe(201);
    expect((await call('POST', `/files/uploads/${assetId}/complete`, admin)).status).toBe(200);

    const response = await publish(admin, {
      clientBatchId: nextBatch(),
      communityIds: [c1, c2],
      kind: 'VOICE',
      fileAssetId: assetId,
    });
    expect(response.status).toBe(201);
    expect(response.body.summary).toEqual({ total: 2, posted: 2, failed: 0 });

    // Delivered to a recipient's conversation as a VOICE message carrying the
    // asset — the end-to-end "a voice note actually arrives" the UI relies on.
    const chat = await call('GET', `/messaging/communities/${c1}/conversation`, admin);
    const page = await call(
      'GET',
      `/messaging/conversations/${chat.body.id as string}/messages`,
      admin,
    );
    const voice = (
      page.body.items as {
        type: string;
        attachments: { fileAssetId: string; kind: string }[];
      }[]
    ).find((m) => m.type === 'VOICE');
    expect(voice?.attachments[0]?.fileAssetId).toBe(assetId);
    expect(voice?.attachments[0]?.kind).toBe('VOICE');
  });

  it("refuses to publish someone else's upload — nothing is posted", async () => {
    const bytes = sampleBytes('image/png', 128);
    const declared = await call('POST', '/files/uploads', admin, {
      kind: 'IMAGE',
      contentType: 'image/png',
      byteSize: bytes.length,
      fileName: 'خاص.png',
    });
    const assetId = (declared.body.asset as { id: string }).id;
    await fetch(`${r.api.base}${(declared.body.upload as { url: string }).url}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });
    await call('POST', `/files/uploads/${assetId}/complete`, admin);

    // The teacher may post in c1, but the asset is the admin's — the whole
    // publish is refused before anything reaches any community.
    const response = await publish(teacher, {
      clientBatchId: nextBatch(),
      communityIds: [c1],
      kind: 'IMAGE',
      fileAssetId: assetId,
    });
    expect(response.status).toBe(422);
    expect(code(response)).toBe('messaging.attachment_not_found');
  });

  it('reports a locked community as locked (not retryable), and posts nothing there', async () => {
    expect((await call('POST', `/communities/${c3}/lock`, admin)).status).toBe(200);
    const response = await publish(admin, {
      clientBatchId: nextBatch(),
      communityIds: [c3],
      kind: 'TEXT',
      body: 'لن يُنشر',
    });
    expect(response.status).toBe(201);
    expect({
      status: outcomes(response)[c3].status,
      retryable: outcomes(response)[c3].retryable,
    }).toEqual({ status: 'locked', retryable: false });
    expect(response.body.summary).toEqual({ total: 1, posted: 0, failed: 1 });
    expect((await call('POST', `/communities/${c3}/unlock`, admin)).status).toBe(200);
  });

  it('rejects a malformed batch (empty targets, empty text, too many targets)', async () => {
    expect(
      (
        await publish(admin, {
          clientBatchId: nextBatch(),
          communityIds: [],
          kind: 'TEXT',
          body: 'x',
        })
      ).status,
    ).toBe(400);

    const emptyBody = await publish(admin, {
      clientBatchId: nextBatch(),
      communityIds: [c1],
      kind: 'TEXT',
      body: '   ',
    });
    expect(emptyBody.status).toBe(422);
    expect(code(emptyBody)).toBe('messaging.publish_body_required');

    const tooMany = await publish(admin, {
      clientBatchId: nextBatch(),
      communityIds: Array.from({ length: 51 }, (_, i) => `c-${i}`),
      kind: 'TEXT',
      body: 'x',
    });
    expect(tooMany.status).toBe(400);
  });
});

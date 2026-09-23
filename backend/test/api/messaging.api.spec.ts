import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { startApi, type RunningApi } from '../support/api-client';
import { sampleBytes } from '../support/files-harness';

const errorOf = (body: Record<string, unknown>) =>
  body.error as { kind?: string; code: string; message: string };

interface Account {
  readonly id: string;
  readonly token: string;
}

/**
 * Messaging and files over real HTTP: the same AppModule and pipeline the
 * server runs, in-memory persistence, and the local storage adapter writing
 * to a temporary directory. What it proves beyond the use-case suites: the
 * routes, their access declarations, validation, status codes, safe errors,
 * and the whole upload → PUT → complete → send → link → download journey.
 */
describe('messaging API', () => {
  let api: RunningApi;
  let storageRoot: string;
  let owner: Account;
  let teacher: Account;
  let student: Account;
  let outsider: Account;

  async function provision(name: string, role: string): Promise<Account> {
    const email = `${name}@institution.test`;
    const password = `${name} passphrase long enough`;
    const created = await api.call('POST', '/admin/users', {
      token: owner.token,
      body: { displayName: name, identifier: email, initialPassword: password },
    });
    const id = created.body.id as string;
    await api.call('POST', `/admin/users/${id}/roles`, { token: owner.token, body: { role } });
    await api.call('POST', `/admin/users/${id}/status`, {
      token: owner.token,
      body: { status: 'ACTIVE' },
    });
    const login = await api.call('POST', '/auth/login', {
      body: { identifier: email, password },
    });
    return { id, token: login.body.accessToken as string };
  }

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'api-storage-'));
    api = await startApi({
      STORAGE_LOCAL_ROOT: storageRoot,
      STORAGE_SIGNING_SECRET: 'api-test-storage-secret-of-at-least-32-bytes',
    });
    const bootstrapped = await api.app.get(BootstrapOwnerUseCase).execute({
      displayName: 'Owner',
      identifierKind: 'email',
      identifier: 'owner@institution.test',
      password: 'owner passphrase one',
      meta: {},
    });
    if (!bootstrapped.ok) throw new Error(bootstrapped.error.code);
    const login = await api.call('POST', '/auth/login', {
      body: { identifier: 'owner@institution.test', password: 'owner passphrase one' },
    });
    owner = { id: bootstrapped.value.id, token: login.body.accessToken as string };
    teacher = await provision('teacher', 'TEACHER');
    student = await provision('student', 'STUDENT');
    outsider = await provision('outsider', 'TEACHER');
  }, 60_000);

  afterAll(async () => {
    await api.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  describe('access', () => {
    it('requires authentication on every messaging route', async () => {
      for (const [method, path] of [
        ['GET', '/messaging/conversations'],
        ['POST', '/messaging/conversations/groups'],
        ['GET', '/messaging/conversations/x/messages'],
        ['POST', '/messaging/conversations/x/messages/text'],
        ['DELETE', '/messaging/conversations/x/participants/y'],
        ['POST', '/files/uploads'],
      ] as const) {
        const response = await api.call(method, path);
        expect(response.status).toBe(401);
        expect(errorOf(response.body).code).toBe('identity.authentication_required');
      }
    });

    it('refuses a student at the edge for acts they hold no permission for', async () => {
      const response = await api.call('POST', '/messaging/conversations/groups', {
        token: student.token,
        body: { title: 'Mine', memberIds: [] },
      });
      expect(response.status).toBe(403);
      expect(errorOf(response.body).code).toBe('identity.permission_denied');
    });
  });

  describe('a conversation, end to end', () => {
    let conversationId: string;

    it('creates a group (201) with a complete, explicit shape', async () => {
      const response = await api.call('POST', '/messaging/conversations/groups', {
        token: teacher.token,
        body: { title: 'حلقة الفجر', memberIds: [student.id] },
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        type: 'GROUP',
        title: 'حلقة الفجر',
        memberCount: 2,
        myRole: 'OWNER',
        canPost: true,
        canManageMembers: true,
        unreadCount: 0,
        lastMessage: null,
      });
      expect(response.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      conversationId = response.body.id as string;
    });

    it('sends a text: 201 when stored, 200 for the retry, 409 for a reused key', async () => {
      const path = `/messaging/conversations/${conversationId}/messages/text`;
      const body = { clientMessageId: 'api-key-00000001', body: 'السلام عليكم' };
      const first = await api.call('POST', path, { token: student.token, body });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        sequence: 1,
        type: 'TEXT',
        body: 'السلام عليكم',
        senderId: student.id,
        clientMessageId: 'api-key-00000001',
        attachments: [],
      });

      const retry = await api.call('POST', path, { token: student.token, body });
      expect(retry.status).toBe(200);
      expect(retry.body.id).toBe(first.body.id);

      const reused = await api.call('POST', path, {
        token: student.token,
        body: { ...body, body: 'different' },
      });
      expect(reused.status).toBe(409);
      expect(errorOf(reused.body).code).toBe('messaging.client_message_id_reused');
    });

    it('validates at the edge (400) and in the domain (422)', async () => {
      const path = `/messaging/conversations/${conversationId}/messages/text`;
      const unknownField = await api.call('POST', path, {
        token: student.token,
        body: { clientMessageId: 'api-key-00000002', body: 'x', type: 'VIDEO' },
      });
      expect(unknownField.status).toBe(400);

      const badKey = await api.call('POST', path, {
        token: student.token,
        body: { clientMessageId: 'bad key', body: 'x' },
      });
      expect(badKey.status).toBe(422);
      expect(errorOf(badKey.body).code).toBe('messaging.client_message_id_invalid');

      const badLimit = await api.call(
        'GET',
        `/messaging/conversations/${conversationId}/messages?limit=0`,
        { token: student.token },
      );
      expect(badLimit.status).toBe(400);
    });

    it('lists it for its members, and for nobody else', async () => {
      const mine = await api.call('GET', '/messaging/conversations', { token: teacher.token });
      expect(mine.status).toBe(200);
      expect(mine.body).toMatchObject({
        items: [{ id: conversationId, unreadCount: 1, lastMessage: { sequence: 1 } }],
        nextCursor: null,
      });
      const theirs = await api.call('GET', '/messaging/conversations', { token: outsider.token });
      expect(theirs.body).toEqual({ items: [], nextCursor: null });
    });

    it('answers a non-member exactly as for a conversation that does not exist (404)', async () => {
      const real = await api.call('GET', `/messaging/conversations/${conversationId}/messages`, {
        token: outsider.token,
      });
      const fake = await api.call('GET', '/messaging/conversations/no-such-id/messages', {
        token: outsider.token,
      });
      expect(real.status).toBe(404);
      expect(errorOf(real.body)).toEqual(errorOf(fake.body));
      // Even the institution owner, holding every permission, is not a member.
      const asOwner = await api.call('GET', `/messaging/conversations/${conversationId}`, {
        token: owner.token,
      });
      expect(asOwner.status).toBe(404);
    });

    it('pages the timeline with numeric cursors and marks it read', async () => {
      for (let i = 2; i <= 6; i++) {
        await api.call('POST', `/messaging/conversations/${conversationId}/messages/text`, {
          token: teacher.token,
          body: { clientMessageId: `api-page-${String(i).padStart(8, '0')}`, body: `m${i}` },
        });
      }
      const latest = await api.call(
        'GET',
        `/messaging/conversations/${conversationId}/messages?limit=2`,
        { token: student.token },
      );
      expect((latest.body.items as { sequence: number }[]).map((m) => m.sequence)).toEqual([5, 6]);
      expect(latest.body).toMatchObject({ hasOlder: true, hasNewer: false });
      expect(latest.body.senders).toEqual([{ userId: teacher.id, displayName: 'teacher' }]);

      const older = await api.call(
        'GET',
        `/messaging/conversations/${conversationId}/messages?before=5&limit=2`,
        { token: student.token },
      );
      expect((older.body.items as { sequence: number }[]).map((m) => m.sequence)).toEqual([3, 4]);

      const read = await api.call('POST', `/messaging/conversations/${conversationId}/read`, {
        token: student.token,
        body: { sequence: 6 },
      });
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ lastReadSequence: 6 });
    });
  });

  describe('files: upload, attach, download', () => {
    let conversationId: string;
    let uploadUrl: string;
    let assetId: string;
    let messageId: string;
    let downloadUrl: string;
    const bytes = sampleBytes('image/png', 256);

    beforeAll(async () => {
      const direct = await api.call('POST', '/messaging/conversations/direct', {
        token: teacher.token,
        body: { userId: student.id },
      });
      expect(direct.status).toBe(201);
      conversationId = direct.body.id as string;
      const again = await api.call('POST', '/messaging/conversations/direct', {
        token: teacher.token,
        body: { userId: student.id },
      });
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(conversationId);
    });

    const put = (url: string, body: Buffer, contentType = 'image/png') =>
      fetch(`${api.base}${url}`, { method: 'PUT', headers: { 'content-type': contentType }, body });

    it('declares an upload and receives a signed, relative PUT URL', async () => {
      const response = await api.call('POST', '/files/uploads', {
        token: teacher.token,
        body: {
          kind: 'IMAGE',
          contentType: 'image/png',
          byteSize: bytes.length,
          fileName: 'لوح.png',
        },
      });
      expect(response.status).toBe(201);
      const upload = response.body.upload as { url: string; method: string; headers: object };
      expect(upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
      expect(upload.url).toMatch(
        /^\/files\/local\/[A-Za-z0-9_-]+\?exp=\d+&ct=image%2Fpng&max=256&sig=/,
      );
      uploadUrl = upload.url;
      assetId = (response.body.asset as { id: string }).id;
    });

    it('refuses a transfer that does not match what was signed', async () => {
      expect((await put(uploadUrl, bytes, 'text/html')).status).toBe(422);
      expect((await put(uploadUrl, Buffer.concat([bytes, Buffer.from('!')]))).status).toBe(422);
      const forged = uploadUrl.replace(
        /sig=[^&]+/,
        'sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      );
      const response = await put(forged, bytes);
      expect(response.status).toBe(403);
      expect(errorOf((await response.json()) as Record<string, unknown>).code).toBe(
        'files.link_invalid',
      );
    });

    it('accepts the bytes once (201), then never again (409)', async () => {
      expect((await put(uploadUrl, bytes)).status).toBe(201);
      expect((await put(uploadUrl, bytes)).status).toBe(409);
    });

    it('completes the upload, then sends it as an image message', async () => {
      const completed = await api.call('POST', `/files/uploads/${assetId}/complete`, {
        token: teacher.token,
      });
      expect(completed.status).toBe(200);
      expect(completed.body).toMatchObject({ id: assetId, kind: 'IMAGE', byteSize: 256 });

      const sent = await api.call(
        'POST',
        `/messaging/conversations/${conversationId}/messages/image`,
        {
          token: teacher.token,
          body: { clientMessageId: 'api-image-000001', fileAssetId: assetId, caption: 'الواجب' },
        },
      );
      expect(sent.status).toBe(201);
      expect(sent.body).toMatchObject({
        type: 'IMAGE',
        body: 'الواجب',
        attachments: [
          {
            fileAssetId: assetId,
            available: true,
            kind: 'IMAGE',
            contentType: 'image/png',
            displayName: 'لوح.png',
          },
        ],
      });
      messageId = sent.body.id as string;
    });

    it("refuses to attach someone else's upload", async () => {
      const response = await api.call(
        'POST',
        `/messaging/conversations/${conversationId}/messages/image`,
        {
          token: student.token,
          body: { clientMessageId: 'api-image-000002', fileAssetId: assetId },
        },
      );
      expect(response.status).toBe(422);
      expect(errorOf(response.body).code).toBe('messaging.attachment_not_found');
    });

    it('gives a member a link, and nobody else', async () => {
      const path = `/messaging/conversations/${conversationId}/messages/${messageId}/attachments/${assetId}/link`;
      const response = await api.call('GET', path, { token: student.token });
      expect(response.status).toBe(200);
      downloadUrl = response.body.url as string;
      expect(downloadUrl).toMatch(/^\/files\/local\/.+&cd=inline&/);
      expect((await api.call('GET', path, { token: outsider.token })).status).toBe(404);
    });

    it('serves the exact bytes, as what they were verified to be, never as a page', async () => {
      const response = await fetch(`${api.base}${downloadUrl}`);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      expect(response.headers.get('content-disposition')).toMatch(
        /^inline; filename="___\.png"; filename\*=UTF-8''/,
      );
      expect(response.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);
    });

    it('serves byte ranges, as audio players require', async () => {
      const response = await fetch(`${api.base}${downloadUrl}`, {
        headers: { range: 'bytes=0-7' },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-7/256');
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes.subarray(0, 8))).toBe(true);
      const beyond = await fetch(`${api.base}${downloadUrl}`, { headers: { range: 'bytes=999-' } });
      expect(beyond.status).toBe(416);
    });

    it('never lets a download link write', async () => {
      const response = await put(downloadUrl, bytes);
      expect(response.status).toBe(403);
    });
  });

  describe('membership over HTTP', () => {
    it('adds, removes and lets people leave', async () => {
      const created = await api.call('POST', '/messaging/conversations/groups', {
        token: teacher.token,
        body: { title: 'Membership', memberIds: [] },
      });
      const id = created.body.id as string;
      const added = await api.call('POST', `/messaging/conversations/${id}/participants`, {
        token: teacher.token,
        body: { userIds: [student.id, outsider.id] },
      });
      expect(added.status).toBe(200);
      expect(added.body).toEqual({ added: [student.id, outsider.id], unchanged: [] });

      const removed = await api.call(
        'DELETE',
        `/messaging/conversations/${id}/participants/${outsider.id}`,
        {
          token: teacher.token,
        },
      );
      expect(removed.status).toBe(204);
      const left = await api.call('POST', `/messaging/conversations/${id}/leave`, {
        token: student.token,
      });
      expect(left.status).toBe(204);
      const view = await api.call('GET', `/messaging/conversations/${id}`, {
        token: teacher.token,
      });
      expect(view.body.memberCount).toBe(1);
    });
  });

  it('never leaks internals in any response it gave', () => {
    const all = api.transcript.join('\n');
    expect(all).not.toMatch(
      /at [A-Za-z]+ \(|node_modules|\/home\/|stack|password_hash|storage_key|signingSecret/,
    );
    expect(all).not.toContain(storageRoot);
  });
});

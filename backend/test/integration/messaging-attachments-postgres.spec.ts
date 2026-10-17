import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BootstrapOwnerUseCase } from '../../src/modules/identity/application/bootstrap-owner.use-case';
import { startApi, type RunningApi } from '../support/api-client';
import { sampleBytes } from '../support/files-harness';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

/**
 * The attachment lifecycle end to end over REAL PostgreSQL and the REAL local
 * storage adapter:
 *
 *   declare upload → PUT the bytes (magic-byte + size + signature checks) →
 *   complete → attach to a message → read the message back (rehydrated from
 *   Postgres) → download the exact bytes → and a non-member cannot even obtain
 *   the link.
 *
 * `messaging.api.spec` already proves this journey's HTTP contract, but with
 * in-memory persistence; this proves that the Drizzle file-asset and
 * message-attachment persistence, the storage adapter and the composition agree
 * with it — the same way `people-http-postgres` backs `people.api.spec`. The
 * metadata lives in a fresh scratch database; the bytes live in a temporary
 * directory; both are removed afterwards. No pre-existing server, no shared
 * data, no production/staging secret.
 */
describeWithPostgres(
  'messaging attachments over PostgreSQL + real storage (HTTP round-trip)',
  () => {
    const OWNER = { email: 'owner@institution.test', password: 'owner passphrase one' };

    let scratch: ScratchDatabase;
    let storageRoot: string;
    let api: RunningApi;
    let ownerToken: string;
    const token: Record<string, string> = {};
    const uid: Record<string, string> = {};

    let conversationId: string;
    const bytes = sampleBytes('image/png', 256); // real PNG signature, padded to 256 bytes

    const errorOf = (body: Record<string, unknown>) => body.error as { code: string } | undefined;

    async function login(email: string, password: string): Promise<string> {
      const res = await api.call('POST', '/auth/login', { body: { identifier: email, password } });
      expect(res.status).toBe(200);
      return res.body.accessToken as string;
    }

    async function provision(key: string, role: string): Promise<void> {
      const email = `${key}@institution.test`;
      const password = `${key} passphrase long enough`;
      const created = await api.call('POST', '/admin/users', {
        token: ownerToken,
        body: { displayName: key, identifier: email, initialPassword: password },
      });
      uid[key] = created.body.id as string;
      await api.call('POST', `/admin/users/${uid[key]}/roles`, {
        token: ownerToken,
        body: { role },
      });
      await api.call('POST', `/admin/users/${uid[key]}/status`, {
        token: ownerToken,
        body: { status: 'ACTIVE' },
      });
      token[key] = await login(email, password);
    }

    const put = (url: string, body: Buffer, contentType = 'image/png') =>
      fetch(`${api.base}${url}`, { method: 'PUT', headers: { 'content-type': contentType }, body });

    beforeAll(async () => {
      scratch = await scratchDatabase();
      storageRoot = mkdtempSync(join(tmpdir(), 'it-attach-storage-'));
      api = await startApi({
        DATABASE_URL: scratch.url,
        STORAGE_LOCAL_ROOT: storageRoot,
        STORAGE_SIGNING_SECRET: 'integration-test-storage-secret-of-at-least-32-bytes',
      });
      const bootstrapped = await api.app.get(BootstrapOwnerUseCase).execute({
        displayName: 'Owner',
        identifierKind: 'email',
        identifier: OWNER.email,
        password: OWNER.password,
        meta: {},
      });
      if (!bootstrapped.ok) throw new Error(bootstrapped.error.code);
      ownerToken = await login(OWNER.email, OWNER.password);

      await provision('teacher', 'TEACHER');
      await provision('student', 'STUDENT');
      await provision('outsider', 'TEACHER'); // not a member of the conversation

      const direct = await api.call('POST', '/messaging/conversations/direct', {
        token: token.teacher,
        body: { userId: uid.student },
      });
      expect(direct.status).toBe(201);
      conversationId = direct.body.id as string;
    }, 90_000);

    afterAll(async () => {
      if (api !== undefined) await api.close();
      if (scratch !== undefined) await scratch.drop();
      if (storageRoot !== undefined) rmSync(storageRoot, { recursive: true, force: true });
    });

    let assetId: string;
    let messageId: string;

    it('uploads a file through the signed URL and completes it (bytes verified, stored on disk)', async () => {
      const declared = await api.call('POST', '/files/uploads', {
        token: token.teacher,
        body: {
          kind: 'IMAGE',
          contentType: 'image/png',
          byteSize: bytes.length,
          fileName: 'لوح.png',
        },
      });
      expect(declared.status).toBe(201);
      const upload = declared.body.upload as { url: string; method: string };
      expect(upload.method).toBe('PUT');
      assetId = (declared.body.asset as { id: string }).id;

      expect((await put(upload.url, bytes)).status).toBe(201);
      // Idempotent transfer: the same signed URL cannot be reused.
      expect((await put(upload.url, bytes)).status).toBe(409);

      const completed = await api.call('POST', `/files/uploads/${assetId}/complete`, {
        token: token.teacher,
      });
      expect(completed.status).toBe(200);
      expect(completed.body).toMatchObject({ id: assetId, kind: 'IMAGE', byteSize: 256 });
    });

    it('attaches the upload to an image message (201) with the shape the client reads', async () => {
      const sent = await api.call(
        'POST',
        `/messaging/conversations/${conversationId}/messages/image`,
        {
          token: token.teacher,
          body: { clientMessageId: 'it-attach-000001', fileAssetId: assetId, caption: 'الواجب' },
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

    it('rehydrates the attachment from Postgres when the recipient reads the timeline', async () => {
      const timeline = await api.call(
        'GET',
        `/messaging/conversations/${conversationId}/messages?limit=100`,
        { token: token.student },
      );
      expect(timeline.status).toBe(200);
      const items = timeline.body.items as Record<string, unknown>[];
      const message = items.find((m) => m.id === messageId);
      expect(message).toBeDefined();
      expect(message).toMatchObject({ type: 'IMAGE', conversationId, senderId: uid.teacher });
      const attachments = message!.attachments as Record<string, unknown>[];
      expect(attachments).toHaveLength(1);
      // The exact keys app/lib/data/models/messaging.dart reads off an attachment.
      expect(attachments[0]).toMatchObject({
        fileAssetId: assetId,
        available: true,
        kind: 'IMAGE',
        contentType: 'image/png',
        byteSize: 256,
        displayName: 'لوح.png',
      });
    });

    it('serves the exact original bytes to a member through the signed download link', async () => {
      const link = await api.call(
        'GET',
        `/messaging/conversations/${conversationId}/messages/${messageId}/attachments/${assetId}/link`,
        { token: token.student },
      );
      expect(link.status).toBe(200);
      const url = link.body.url as string;

      const download = await fetch(`${api.base}${url}`);
      expect(download.status).toBe(200);
      // Byte-for-byte equality with what was uploaded — not merely a 200.
      expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);
      expect(download.headers.get('content-type')).toBe('image/png');
      expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('refuses a non-member the download link, so they can never reach the bytes', async () => {
      const link = await api.call(
        'GET',
        `/messaging/conversations/${conversationId}/messages/${messageId}/attachments/${assetId}/link`,
        { token: token.outsider },
      );
      // A non-member hears the same 404 as for a message that does not exist.
      expect(link.status).toBe(404);
      expect(errorOf(link.body)?.code).toBeDefined();
    });
  },
);

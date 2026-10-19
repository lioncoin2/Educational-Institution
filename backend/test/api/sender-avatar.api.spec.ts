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
 * The sender picture over real HTTP. A conversation page carries each sender's
 * `avatarFileAssetId` (a reference) beside the name; a member turns a sender's
 * picture into a short-lived link through a message-scoped route. Proves the
 * reference surfaces, the link serves the bytes, a sender with no picture reads
 * as 404, and a non-member is refused.
 */
describe('message sender avatar API', () => {
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
    const login = await api.call('POST', '/auth/login', { body: { identifier: email, password } });
    return { id, token: login.body.accessToken as string };
  }

  async function setAvatar(account: Account): Promise<string> {
    const bytes = sampleBytes('image/png', 256);
    const declared = await api.call('POST', '/files/uploads', {
      token: account.token,
      body: { kind: 'IMAGE', contentType: 'image/png', byteSize: bytes.length, fileName: 'a.png' },
    });
    const assetId = (declared.body.asset as { id: string }).id;
    await fetch(`${api.base}${(declared.body.upload as { url: string }).url}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });
    await api.call('POST', `/files/uploads/${assetId}/complete`, { token: account.token });
    const set = await api.call('PUT', '/files/me/avatar', {
      token: account.token,
      body: { fileAssetId: assetId },
    });
    expect(set.status).toBe(200);
    return assetId;
  }

  async function directWith(a: Account, b: Account): Promise<string> {
    const direct = await api.call('POST', '/messaging/conversations/direct', {
      token: a.token,
      body: { userId: b.id },
    });
    return direct.body.id as string;
  }

  async function sendText(account: Account, conversationId: string, key: string): Promise<string> {
    const sent = await api.call(
      'POST',
      `/messaging/conversations/${conversationId}/messages/text`,
      {
        token: account.token,
        body: { clientMessageId: key, body: 'مرحبا' },
      },
    );
    expect(sent.status).toBe(201);
    return sent.body.id as string;
  }

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'sender-avatar-'));
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
    outsider = await provision('outsider', 'STUDENT');
  }, 60_000);

  afterAll(async () => {
    await api.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('carries the sender picture reference on the conversation page and serves a link', async () => {
    const assetId = await setAvatar(teacher);
    const conversationId = await directWith(teacher, student);
    const messageId = await sendText(teacher, conversationId, 'avatar-key-00000001');

    // The page the student reads carries the teacher's avatar reference.
    const page = await api.call('GET', `/messaging/conversations/${conversationId}/messages`, {
      token: student.token,
    });
    expect(page.status).toBe(200);
    const sender = (
      page.body.senders as { userId: string; avatarFileAssetId: string | null }[]
    ).find((s) => s.userId === teacher.id);
    expect(sender?.avatarFileAssetId).toBe(assetId);

    // The student may mint a short-lived link to that sender's picture.
    const link = await api.call(
      'GET',
      `/messaging/conversations/${conversationId}/messages/${messageId}/sender/avatar`,
      { token: student.token },
    );
    expect(link.status).toBe(200);
    const fetched = await fetch(`${api.base}${link.body.url as string}`);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');
  });

  it('reports no picture when the sender has none', async () => {
    const conversationId = await directWith(student, teacher);
    const messageId = await sendText(student, conversationId, 'avatar-key-00000002');
    const link = await api.call(
      'GET',
      `/messaging/conversations/${conversationId}/messages/${messageId}/sender/avatar`,
      { token: teacher.token },
    );
    expect(link.status).toBe(404);
    expect(errorOf(link.body).code).toBe('messaging.sender_avatar_not_found');
  });

  it('refuses a non-member asking for a sender picture', async () => {
    const conversationId = await directWith(teacher, student);
    const messageId = await sendText(teacher, conversationId, 'avatar-key-00000003');
    const link = await api.call(
      'GET',
      `/messaging/conversations/${conversationId}/messages/${messageId}/sender/avatar`,
      { token: outsider.token },
    );
    expect(link.status).toBe(404);
  });
});

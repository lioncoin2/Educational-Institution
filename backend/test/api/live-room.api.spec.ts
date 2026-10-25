import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LiveReconciler } from '../../src/modules/live/application/live-reconciler';
import type { ApiResponse } from '../support/api-client';
import { sampleBytes } from '../support/files-harness';
import { LogCapture } from '../support/log-capture';
import { startRealtimeApi, type Account, type RealtimeApi } from '../support/realtime-api';
import type { TestSocket } from '../support/realtime-client';

/**
 * The live room's C15 additions over real HTTP and the WebSocket: a
 * participant's picture (ADR 0048) — the host's for everyone, the rest for a
 * moderator, served from identity's reference through Files — and the room's
 * four reactions (ADR 0049), delivered to the session's other participants and
 * refused to anyone else.
 */
describe('live room API — pictures and reactions (C15)', () => {
  let r: RealtimeApi;
  let storageRoot: string;
  let admin: Account; // creates — and so owns — the community, and hosts
  let teacher: Account; // a member without any grant
  let student: Account;
  let outsider: Account;
  let communityId: string;
  let sessionId: string;
  let teacherSocket: TestSocket;
  let studentSocket: TestSocket;

  async function setAvatar(account: Account): Promise<void> {
    const bytes = sampleBytes('image/png', 256);
    const declared = await r.api.call('POST', '/files/uploads', {
      token: account.token,
      body: { kind: 'IMAGE', contentType: 'image/png', byteSize: bytes.length, fileName: 'a.png' },
    });
    const assetId = (declared.body.asset as { id: string }).id;
    await fetch(`${r.api.base}${(declared.body.upload as { url: string }).url}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });
    await r.api.call('POST', `/files/uploads/${assetId}/complete`, { token: account.token });
    const set = await r.api.call('PUT', '/files/me/avatar', {
      token: account.token,
      body: { fileAssetId: assetId },
    });
    expect(set.status).toBe(200);
  }

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'live-room-'));
    r = await startRealtimeApi(
      {
        LIVEKIT_API_SECRET: 'development-only-secret',
        LIVE_MEDIA_PROVIDER: '',
        STORAGE_LOCAL_ROOT: storageRoot,
        STORAGE_SIGNING_SECRET: 'api-test-storage-secret-of-at-least-32-bytes',
      },
      { logger: new LogCapture() },
    );
    await r.api.app.get(LiveReconciler, { strict: false }).stop();
    admin = await r.provision('admin', 'ADMIN', 'الإدارة');
    teacher = await r.provision('teacher', 'TEACHER', 'الأستاذة حفصة');
    student = await r.provision('student', 'STUDENT', 'مريم');
    outsider = await r.provision('outsider', 'STUDENT', 'زائرة');
    communityId = await r.createCommunity(admin, 'حلقة التجويد');
    await r.addToCommunity(admin, communityId, [teacher, student]);
    for (const account of [admin, teacher, student]) await setAvatar(account);
    const started = await r.api.call('POST', `/live/communities/${communityId}/sessions`, {
      token: admin.token,
    });
    expect(started.status).toBe(201);
    sessionId = started.body.id as string;
    teacherSocket = await r.connect(teacher);
    studentSocket = await r.connect(student);
  }, 60_000);

  afterAll(async () => {
    await teacherSocket?.close();
    await studentSocket?.close();
    await r.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  const code = (response: ApiResponse) =>
    (response.body.error as Record<string, unknown> | undefined)?.code;
  const avatar = (by: Account, of: Account) =>
    r.api.call('GET', `/live/sessions/${sessionId}/participants/${of.id}/avatar`, {
      token: by.token,
    });
  const react = (by: Account, kind: unknown, session = sessionId) =>
    r.api.call('POST', `/live/sessions/${session}/reactions`, { token: by.token, body: { kind } });

  describe('a participant’s picture (ADR 0048)', () => {
    it('serves the host’s picture to a listener — a link that serves the image', async () => {
      const link = await avatar(student, admin);
      expect(link.status).toBe(200);
      expect(link.body).toEqual({
        url: expect.any(String) as string,
        expiresAt: expect.any(String) as string,
      });
      const image = await fetch(`${r.api.base}${String(link.body.url)}`);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toContain('image/png');
    });

    it('gives a listener no other participant’s picture, a moderator anyone’s in the session', async () => {
      const refused = await avatar(student, teacher);
      expect(refused.status).toBe(404);
      expect(code(refused)).toBe('live.participant_avatar_not_found');
      expect((await avatar(admin, teacher)).status).toBe(200);
      expect((await avatar(student, student)).status).toBe(200);
    });

    it('answers 404 — initials — for someone with no picture, and keeps a non-member out', async () => {
      await r.api.call('DELETE', '/files/me/avatar', { token: teacher.token });
      expect(code(await avatar(admin, teacher))).toBe('live.participant_avatar_not_found');
      const stranger = await avatar(outsider, admin);
      expect(stranger.status).toBe(404);
      expect(code(stranger)).toBe('live.session_not_found');
      expect(
        (await r.api.call('GET', `/live/sessions/${sessionId}/participants/${admin.id}/avatar`))
          .status,
      ).toBe(401);
    });
  });

  describe('the room’s reactions (ADR 0049)', () => {
    it('accepts a reaction (202) and delivers the kind alone to the other participants', async () => {
      const sent = await react(student, 'heart');
      expect(sent.status).toBe(202);
      expect(sent.body).toEqual({ reactionId: expect.any(String) as string, kind: 'heart' });
      const frame = await teacherSocket.waitFor((f) => f.type === 'live.reaction');
      expect(frame).toMatchObject({ type: 'live.reaction', sessionId, communityId, kind: 'heart' });
      expect(JSON.stringify(frame)).not.toContain(student.id);
    });

    it('validates at the edge (400) and in the domain (422)', async () => {
      const extra = await r.api.call('POST', `/live/sessions/${sessionId}/reactions`, {
        token: student.token,
        body: { kind: 'heart', sentBy: admin.id },
      });
      expect(extra.status).toBe(400);
      const unknown = await react(student, 'fire');
      expect(unknown.status).toBe(422);
      expect(code(unknown)).toBe('live.reaction_invalid');
    });

    it('refuses a non-member exactly as an unknown session, and an anonymous caller', async () => {
      const stranger = await react(outsider, 'clap');
      expect(stranger.status).toBe(404);
      expect(code(stranger)).toBe('live.session_not_found');
      expect(
        (
          await r.api.call('POST', `/live/sessions/${sessionId}/reactions`, {
            body: { kind: 'clap' },
          })
        ).status,
      ).toBe(401);
    });

    it('refuses after the session ended (412), and the room is quiet', async () => {
      const ended = await r.api.call('POST', `/live/sessions/${sessionId}/end`, {
        token: admin.token,
      });
      expect(ended.status).toBe(200);
      const late = await react(student, 'smile');
      expect(late.status).toBe(412);
      expect(code(late)).toBe('live.session_not_live');
    });
  });
});

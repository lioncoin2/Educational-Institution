import type { Principal } from '../../../shared';
import { liveHarness, type LiveHarness } from '../../../../test/support/live-harness';
import { LiveSessionsReader } from './live-sessions.reader';

/**
 * LIVE_SESSIONS (live.md §13): a session's scope from Live's own record —
 * never the media provider, and no principal.
 */
describe('LiveSessionsReader', () => {
  let h: LiveHarness;
  let reader: LiveSessionsReader;
  let communityId: string;
  let owner: Principal;

  beforeEach(async () => {
    h = liveHarness();
    reader = new LiveSessionsReader(h.sessions);
    ({ id: communityId, owner } = await h.community('teacher-1', 'student-1'));
  });

  afterEach(() => jest.restoreAllMocks());

  it('describes a live session: its id, community and host, active', async () => {
    const session = await h.startSession(owner, communityId);
    const calls = h.rtc.calls.length;

    expect(await reader.describe(session.id)).toEqual({
      liveSessionId: session.id,
      communityId,
      hostUserId: 'teacher-1',
      active: true,
    });
    // Live's own record only: the provider is never asked.
    expect(h.rtc.calls).toHaveLength(calls);
  });

  it('still describes an ended session — whose it was — as no longer active', async () => {
    const session = await h.startSession(owner, communityId);
    await h.lifecycle.endBySystem(session.id, 'idle');

    expect(await reader.describe(session.id)).toEqual({
      liveSessionId: session.id,
      communityId,
      hostUserId: 'teacher-1',
      active: false,
    });
  });

  it('answers with the media provider down — it never asks it', async () => {
    const session = await h.startSession(owner, communityId);
    h.rtc.setUnavailable(true);

    expect(await reader.describe(session.id)).toMatchObject({ active: true });
  });

  it('answers null for a session it does not know', async () => {
    expect(await reader.describe('00000000-0000-4000-8000-00000000dead')).toBeNull();
    expect(await reader.describe('')).toBeNull();
  });

  it('rejects when Live’s store cannot answer — never null for "could not tell"', async () => {
    const session = await h.startSession(owner, communityId);
    jest.spyOn(h.sessions, 'findById').mockRejectedValueOnce(new Error('connection reset'));

    await expect(reader.describe(session.id)).rejects.toThrow('connection reset');
  });
});

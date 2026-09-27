import { asId } from '../../../shared';
import { liveRepositoryContract } from '../../../../test/support/live-contract-suite';
import { newLiveSession } from '../domain/live-session';
import { InMemoryLiveStore, MODERATION_LOG_LIMIT } from './in-memory-live-repositories';

// Mock mode keeps every guarantee the Postgres adapters give; the Postgres
// suite runs the same contract over Drizzle.
liveRepositoryContract('in memory', () => {
  const store = new InMemoryLiveStore();
  return {
    sessions: store.sessions,
    requests: store.requests,
    presenters: store.presenters,
    moderationOf: async (sessionId) => store.moderationOf(sessionId),
    presenterGrantsOf: async (sessionId) => store.presenterGrantsOf(sessionId),
  };
});

describe('the in-memory live store', () => {
  it('keeps only the newest moderation rows, so a long-running development server stays bounded', async () => {
    const store = new InMemoryLiveStore();
    const at = new Date('2026-09-27T10:00:00.000Z');
    const session = newLiveSession({
      id: asId<'LiveSession'>('session-1'),
      communityId: 'community-1',
      hostUserId: 'teacher-1',
      at,
      participantCap: 300,
      moderatorReserve: 10,
    });
    const row = (n: number, type: 'start_session' | 'reset_media') => ({
      id: asId<'ModerationAction'>(`action-${n}`),
      sessionId: session.id,
      actorUserId: null,
      targetUserId: null,
      type,
      at,
    });
    await store.sessions.start(session, row(0, 'start_session'));
    for (let epoch = 0; epoch < MODERATION_LOG_LIMIT; epoch += 1) {
      await store.sessions.bumpEpoch(session.id, epoch, row(epoch + 1, 'reset_media'));
    }
    const kept = store.moderationOf(session.id);
    expect(kept).toHaveLength(MODERATION_LOG_LIMIT);
    expect(kept[0]?.id).toBe('action-1');
    expect(kept.at(-1)?.id).toBe(`action-${MODERATION_LOG_LIMIT}`);
    // The record itself is whole: bounding the log never loses a change.
    expect((await store.sessions.findById(session.id))?.mediaRoomEpoch).toBe(MODERATION_LOG_LIMIT);
  });
});

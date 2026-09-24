import { sql } from 'drizzle-orm';

import * as communityChat from '../../src/modules/messaging/domain/community-chat';
import type * as CommunityChat from '../../src/modules/messaging/domain/community-chat';
import type { CommunityMemberState } from '../../src/modules/messaging/domain/community-chat';
import { DrizzleMessagingRepository } from '../../src/modules/messaging/infrastructure/drizzle-messaging-repository';
import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import { describeWithPostgres, scratchDatabase, type ScratchDatabase } from '../support/postgres';

// The applier's in-memory register, made to forget its version check — so
// the only thing left between a stale state and the row is the database.
jest.mock('../../src/modules/messaging/domain/community-chat', () => {
  const actual = jest.requireActual<typeof CommunityChat>(
    '../../src/modules/messaging/domain/community-chat',
  );
  return { ...actual, projectMember: jest.fn(actual.projectMember) };
});

const actual = jest.requireActual<typeof CommunityChat>(
  '../../src/modules/messaging/domain/community-chat',
);
const projectMember = communityChat.projectMember as jest.MockedFunction<
  typeof communityChat.projectMember
>;

const ids = new UuidIdGenerator();
const AT = new Date('2026-09-23T10:00:00.000Z');
const state = (version: number, active: boolean): CommunityMemberState => ({
  userId: 'u-guarded',
  membershipId: 'stint-1',
  active,
  joinedAt: AT,
  version,
});

/**
 * The register's guard is repeated in the database (community-chat.md §6.3):
 * `ON CONFLICT … DO UPDATE … WHERE coalesce(source_version, 0) <
 * excluded.source_version`. With the application's own check bypassed, a
 * stale state still changes nothing — and the member count, computed from
 * what was really written, stays exact.
 */
describeWithPostgres('the projection guard in the database', () => {
  let scratch: ScratchDatabase;
  let repository: DrizzleMessagingRepository;

  beforeAll(async () => {
    scratch = await scratchDatabase();
    repository = new DrizzleMessagingRepository(scratch.db);
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  afterEach(() => {
    projectMember.mockImplementation(actual.projectMember);
  });

  const row = async (conversationId: string) =>
    (
      await scratch.db.execute(sql`
        select p.source_version::int as version, p.left_at is null as current, c.member_count
          from conversation_participants p join conversations c on c.id = p.conversation_id
         where p.conversation_id = ${conversationId} and p.user_id = 'u-guarded'`)
    ).rows[0];

  it('holds a newer row against a stale state even when the code lets it through', async () => {
    const chat = await repository.materializeCommunityChat({
      id: ids.next<'Conversation'>(),
      communityId: `c-${ids.next()}`,
      at: AT,
    });
    await repository.applyCommunityMembership({
      conversationId: chat.id,
      states: [state(10, true)],
      advance: null,
      at: AT,
    });

    // The code now "decides" every state is news, whatever its version.
    projectMember.mockImplementation((current, incoming, conversation, at) =>
      actual.projectMember(current, incoming, conversation, at, { override: true }),
    );
    const stale = await repository.applyCommunityMembership({
      conversationId: chat.id,
      states: [state(3, false)],
      advance: null,
      at: AT,
    });
    expect(projectMember).toHaveBeenCalled();
    expect(stale).toMatchObject({ kind: 'applied', left: 0, memberCount: 1 });
    expect(await row(chat.id)).toEqual({ version: 10, current: true, member_count: 1 });

    // Control: the same write with the reconciler's override goes through —
    // so it was the guard, not the data, that stopped it.
    const overridden = await repository.applyCommunityMembership({
      conversationId: chat.id,
      states: [state(3, false)],
      advance: null,
      override: true,
      at: AT,
    });
    expect(overridden).toMatchObject({ kind: 'applied', left: 1, memberCount: 0 });
    expect(await row(chat.id)).toEqual({ version: 3, current: false, member_count: 0 });
  });
});

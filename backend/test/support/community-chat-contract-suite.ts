import { UuidIdGenerator } from '../../src/platform/primitives/uuid-id-generator';
import type { CommunityMemberState } from '../../src/modules/messaging/domain/community-chat';
import { newChannelConversation } from '../../src/modules/messaging/domain/conversation';
import type {
  MessagingReadModel,
  MessagingRepository,
} from '../../src/modules/messaging/domain/ports';

export interface CommunityChatStores {
  readonly repository: MessagingRepository;
  readonly readModel: MessagingReadModel;
}

const ids = new UuidIdGenerator();
const AT = new Date('2026-09-23T10:00:00.000Z');
const JOINED = new Date('2026-09-20T10:00:00.000Z');

const member = (
  userId: string,
  version: number,
  active = true,
  membershipId = `${userId}-stint-1`,
): CommunityMemberState => ({ userId, membershipId, active, joinedAt: JOINED, version });

/**
 * The community-chat half of messaging's ports, as a contract: the in-memory
 * store and the Drizzle adapters must answer every case identically, so mock
 * mode keeps the guarantees Postgres gives (community-chat.md §12.2, §17).
 */
export function communityChatStoreContract(
  name: string,
  stores: () => Promise<CommunityChatStores> | CommunityChatStores,
): void {
  describe(`community chat stores — ${name}`, () => {
    let repository: MessagingRepository;
    let readModel: MessagingReadModel;

    beforeEach(async () => {
      ({ repository, readModel } = await stores());
    });

    const community = () => `community-${ids.next()}`;
    const chat = (communityId: string) =>
      repository.materializeCommunityChat({
        id: ids.next<'Conversation'>(),
        communityId,
        at: AT,
      });
    const user = () => `user-${ids.next()}`;

    it('materializes one chat per community, whatever id each call proposes', async () => {
      const communityId = community();
      const first = await chat(communityId);
      const again = await chat(communityId);
      expect(again.id).toBe(first.id);
      expect(first).toMatchObject({
        type: 'CHANNEL',
        title: null,
        communityId,
        projectedMembershipVersion: 0,
        memberCount: 0,
        createdBy: 'system:messaging-community-chat',
      });
      expect(await readModel.communityChat(communityId)).toEqual({
        conversationId: first.id,
        communityId,
        projectedVersion: 0,
      });
    });

    it('finds the chats of many communities in one lookup, and nothing for the rest', async () => {
      const [a, b, none] = [community(), community(), community()];
      const chatA = await chat(a);
      const chatB = await chat(b);
      const found = await readModel.communityChatsFor([a, b, none, a]);
      expect([...found].sort((x, y) => x.communityId.localeCompare(y.communityId))).toEqual(
        [
          { conversationId: chatA.id, communityId: a, projectedVersion: 0 },
          { conversationId: chatB.id, communityId: b, projectedVersion: 0 },
        ].sort((x, y) => x.communityId.localeCompare(y.communityId)),
      );
      expect(await readModel.communityChat(none)).toBeNull();
      expect(await readModel.communityChatsFor([])).toEqual([]);
    });

    it('applies joins, leaves and tombstones, moving the count and the version together', async () => {
      const conversation = await chat(community());
      const [a, b, c] = [user(), user(), user()];
      const applied = await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [member(a, 1), member(b, 2), member(c, 3, false)],
        advance: { from: 0, to: 3 },
        at: AT,
      });
      expect(applied).toEqual({
        kind: 'applied',
        joined: 2,
        rejoined: 0,
        left: 0,
        tombstoned: 1,
        projectedVersion: 3,
        memberCount: 2,
      });
      expect(await repository.findParticipant(conversation.id, a)).toMatchObject({
        role: 'MEMBER',
        addedBy: null,
        leftAt: null,
        sourceVersion: 1,
        sourceMembershipId: `${a}-stint-1`,
        sourceJoinedAt: JOINED,
      });
      expect(await repository.findParticipant(conversation.id, c)).toMatchObject({
        sourceVersion: 3,
        lastReadSequence: 0,
        hiddenThroughSequence: 0,
      });
      expect((await repository.findParticipant(conversation.id, c))?.leftAt).not.toBeNull();

      const left = await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [member(a, 4, false)],
        advance: { from: 3, to: 4 },
        at: AT,
      });
      expect(left).toMatchObject({ kind: 'applied', left: 1, memberCount: 1, projectedVersion: 4 });
      const members = await readModel.listMemberIds(conversation.id, { limit: 10 });
      expect(members.userIds).toEqual([b]);
    });

    it('ignores a replay and anything older, and records a rejoin by its new stint', async () => {
      const conversation = await chat(community());
      const a = user();
      await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [member(a, 5)],
        advance: null,
        at: AT,
      });
      const replay = await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [member(a, 5)],
        advance: null,
        at: AT,
      });
      expect(replay).toMatchObject({ joined: 0, left: 0, memberCount: 1 });
      const older = await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [member(a, 3, false)],
        advance: null,
        at: AT,
      });
      expect(older).toMatchObject({ left: 0, memberCount: 1 });
      const rejoined = await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [member(a, 9, true, `${a}-stint-2`)],
        advance: null,
        at: AT,
      });
      expect(rejoined).toMatchObject({ rejoined: 1, memberCount: 1 });
      expect(await repository.findParticipant(conversation.id, a)).toMatchObject({
        sourceVersion: 9,
        sourceMembershipId: `${a}-stint-2`,
        leftAt: null,
      });
    });

    it('advances the projected version only across a contiguous range, and never back', async () => {
      const conversation = await chat(community());
      const a = user();
      await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [member(a, 50)],
        advance: { from: 0, to: 50 },
        at: AT,
      });
      const behind = await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [],
        advance: { from: 10, to: 20 },
        at: AT,
      });
      expect(behind).toMatchObject({ projectedVersion: 50 });
      // A gap below `from`: the rows apply, the version holds, the count moves.
      const b = user();
      const gap = await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [member(b, 70)],
        advance: { from: 60, to: 70 },
        at: AT,
      });
      expect(gap).toMatchObject({ joined: 1, projectedVersion: 50, memberCount: 2 });
      expect(
        (await readModel.communityChat(conversation.communityId ?? ''))?.projectedVersion,
      ).toBe(50);
    });

    it('lets only the override lower a row, and only the reset lower the chat', async () => {
      const conversation = await chat(community());
      const a = user();
      await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [member(a, 40)],
        advance: { from: 0, to: 40 },
        at: AT,
      });
      const overridden = await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [member(a, 12, false)],
        advance: null,
        override: true,
        at: AT,
      });
      expect(overridden).toMatchObject({ left: 1, memberCount: 0, projectedVersion: 40 });
      expect(await repository.findParticipant(conversation.id, a)).toMatchObject({
        sourceVersion: 12,
      });
      await repository.resetProjectedVersion(conversation.id, 12);
      expect(
        (await readModel.communityChat(conversation.communityId ?? ''))?.projectedVersion,
      ).toBe(12);
      await expect(repository.resetProjectedVersion(conversation.id, -1)).rejects.toThrow(
        RangeError,
      );
    });

    it('walks the rows the reconciler compares: current members, and any row above a version', async () => {
      const conversation = await chat(community());
      const [a, b, c] = [user(), user(), user()].sort();
      await repository.applyCommunityMembership({
        conversationId: conversation.id,
        states: [member(a, 1), member(b, 30, false), member(c, 5, false)],
        advance: null,
        at: AT,
      });
      const rows = await readModel.projectionRows(conversation.id, { limit: 10, versionAbove: 10 });
      expect(rows.items.map((row) => [row.userId, row.active, row.sourceVersion])).toEqual([
        [a, true, 1],
        [b, false, 30],
      ]);
      const first = await readModel.projectionRows(conversation.id, { limit: 1, versionAbove: 0 });
      expect(first.next).toBe(a);
    });

    it('refuses a conversation that is not a community chat, and says when there is none', async () => {
      const channel = newChannelConversation({
        id: ids.next<'Conversation'>(),
        creator: user(),
        title: 'Notices',
        memberIds: [],
        publisherIds: [],
        at: AT,
      });
      if (!channel.ok) throw new Error(channel.error.code);
      await repository.createConversation(channel.value);
      expect(
        await repository.applyCommunityMembership({
          conversationId: channel.value.conversation.id,
          states: [member(user(), 1)],
          advance: null,
          at: AT,
        }),
      ).toEqual({ kind: 'not_community_chat' });
      expect(
        await repository.applyCommunityMembership({
          conversationId: ids.next<'Conversation'>(),
          states: [],
          advance: null,
          at: AT,
        }),
      ).toEqual({ kind: 'conversation_not_found' });
    });

    it('refuses a batch above 1,000 states, or naming a member twice, before touching anything', async () => {
      const conversation = await chat(community());
      const a = user();
      await expect(
        repository.applyCommunityMembership({
          conversationId: conversation.id,
          states: [member(a, 1), member(a, 2)],
          advance: null,
          at: AT,
        }),
      ).rejects.toThrow(RangeError);
      await expect(
        repository.applyCommunityMembership({
          conversationId: conversation.id,
          states: Array.from({ length: 1001 }, (_, i) => member(`u-${i}`, i + 1)),
          advance: null,
          at: AT,
        }),
      ).rejects.toThrow(RangeError);
      expect(await readModel.listMemberIds(conversation.id, { limit: 10 })).toEqual({
        userIds: [],
        next: null,
      });
    });
  });
}

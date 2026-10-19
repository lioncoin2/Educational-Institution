import type { Principal } from '../../../shared';
import {
  META,
  codeOf,
  communitiesHarness,
  type CommunitiesHarness,
} from '../../../../test/support/communities-harness';
import type { CommunityKind } from '../contracts/vocabulary';

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
};

/**
 * Groups & channels — chat mode and posting authorization (ADR 0039). Posting
 * is decided by COMMUNITY_AUTHORIZATION on the community's mode, never by the
 * conversation type or a client: a new group is open to its members, an admin
 * restricts and restores it, a channel publishes only to the owner and
 * delegated publishers, and a lock blocks everyone whatever the mode.
 */
describe('community chat mode & posting (ADR 0039)', () => {
  let h: CommunitiesHarness;
  let admin: Principal;
  let member: Principal;
  let publisher: Principal;

  beforeEach(() => {
    h = communitiesHarness();
    admin = h.person('admin-1', ['ADMIN']);
    member = h.person('student-1', ['STUDENT']); // an ordinary member: no communities.moderate
    publisher = h.person('teacher-1', ['TEACHER']); // holds the publisher ceiling
  });

  async function community(kind: CommunityKind): Promise<string> {
    const created = unwrap(
      await h.create.execute({ principal: admin, title: 'حلقة', kind, meta: META }),
    );
    unwrap(
      await h.add.execute({
        principal: admin,
        communityId: created.id,
        userIds: ['student-1', 'teacher-1'],
        meta: META,
      }),
    );
    return created.id;
  }

  const authorizePost = (who: Principal, id: string) =>
    h.authorization.authorize(who, id, 'community.chat.post');

  it('a new group is open — an ordinary member posts on membership, with no grant', async () => {
    const created = unwrap(
      await h.create.execute({ principal: admin, title: 'ح', kind: 'GROUP', meta: META }),
    );
    expect(created.chatMode).toBe('GROUP_OPEN');
    const id = await community('GROUP');
    const permit = unwrap(await authorizePost(member, id));
    expect(permit.basis).toBe('membership'); // not a grant, not owner
    expect(permit.grantId).toBeNull();
  });

  it('a new channel restricts publishing to the owner — a member cannot publish', async () => {
    const created = unwrap(
      await h.create.execute({ principal: admin, title: 'ق', kind: 'CHANNEL', meta: META }),
    );
    expect(created.chatMode).toBe('CHANNEL');
    const id = await community('CHANNEL');
    expect((await authorizePost(member, id)).ok).toBe(false);
    expect((await authorizePost(admin, id)).ok).toBe(true); // the owner publishes
  });

  it('an admin restricts member posting, then restores it', async () => {
    const id = await community('GROUP');
    const restricted = unwrap(
      await h.setChatMode.execute({
        principal: admin,
        communityId: id,
        membersMayPost: false,
        meta: META,
      }),
    );
    expect(restricted.chatMode).toBe('GROUP_RESTRICTED');
    expect(restricted.me.canPost).toBe(true); // the admin still posts
    expect((await authorizePost(member, id)).ok).toBe(false); // the member no longer does
    expect((await authorizePost(admin, id)).ok).toBe(true);

    const restored = unwrap(
      await h.setChatMode.execute({
        principal: admin,
        communityId: id,
        membersMayPost: true,
        meta: META,
      }),
    );
    expect(restored.chatMode).toBe('GROUP_OPEN');
    expect((await authorizePost(member, id)).ok).toBe(true);
  });

  it('an ordinary member cannot change the posting restriction', async () => {
    const id = await community('GROUP');
    const refused = await h.setChatMode.execute({
      principal: member,
      communityId: id,
      membersMayPost: false,
      meta: META,
    });
    // Lacks the communities.moderate ceiling → identity refuses before any write.
    expect(codeOf(refused)).toBe('identity.permission_denied');
    // And the mode is unchanged: the member still posts.
    expect((await authorizePost(member, id)).ok).toBe(true);
  });

  it('restricting does not grant the member any administrative capability', async () => {
    const id = await community('GROUP');
    unwrap(
      await h.setChatMode.execute({
        principal: admin,
        communityId: id,
        membersMayPost: false,
        meta: META,
      }),
    );
    expect((await h.authorization.authorize(member, id, 'community.chat.manage')).ok).toBe(false);
    const view = unwrap(await h.get.execute({ principal: member, communityId: id, meta: META }));
    expect(view.me.capabilities).not.toContain('community.chat.manage');
    expect(view.me.standing).toBe('MEMBER');
  });

  it('a channel publisher publishes once granted, and stops the moment the grant is revoked', async () => {
    const id = await community('CHANNEL');
    expect((await authorizePost(publisher, id)).ok).toBe(false); // a plain member, not yet a publisher
    const [grantId] = await h.delegate(admin, id, 'teacher-1', 'community.chat.post');
    const permit = unwrap(await authorizePost(publisher, id));
    expect(permit.basis).toBe('grant');
    unwrap(await h.revokeGrant.execute({ principal: admin, communityId: id, grantId, meta: META }));
    expect((await authorizePost(publisher, id)).ok).toBe(false); // revoked → refused at once
  });

  it('a channel cannot be switched to open member posting', async () => {
    const id = await community('CHANNEL');
    const refused = await h.setChatMode.execute({
      principal: admin,
      communityId: id,
      membersMayPost: true,
      meta: META,
    });
    expect(codeOf(refused)).toBe('communities.chat_mode_transition_invalid');
  });

  it('a LOCKED community blocks posting for everyone who could otherwise post', async () => {
    const openGroup = await community('GROUP');
    const channel = await community('CHANNEL');
    for (const id of [openGroup, channel]) {
      unwrap(
        await h.status.execute({ principal: admin, communityId: id, to: 'LOCKED', meta: META }),
      );
      // The owner would publish in either mode; the lock refuses them.
      expect(codeOf(await authorizePost(admin, id))).toBe('communities.community_locked');
    }
    // An open-group member who would otherwise post is refused by the lock too.
    expect(codeOf(await authorizePost(member, openGroup))).toBe('communities.community_locked');
  });

  it('me.canPost reflects the mode for an ordinary member', async () => {
    const id = await community('GROUP');
    expect(
      unwrap(await h.get.execute({ principal: member, communityId: id, meta: META })).me.canPost,
    ).toBe(true);
    unwrap(
      await h.setChatMode.execute({
        principal: admin,
        communityId: id,
        membersMayPost: false,
        meta: META,
      }),
    );
    expect(
      unwrap(await h.get.execute({ principal: member, communityId: id, meta: META })).me.canPost,
    ).toBe(false);
  });
});

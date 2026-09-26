import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';

import 'community_test_support.dart';

/// The demo's management keeps the server's rules as the server applies
/// them — its `me.operations`, links and joining, removing and leaving,
/// locking, grants and handing over — so the screens built on it behave the
/// same against the real API. Each group names the rule it pins.
void main() {
  const open = MockCommunityRepository.openId;
  const owned = MockCommunityRepository.ownedId;
  const delegated = MockCommunityRepository.delegatedId;
  const lockedOne = MockCommunityRepository.lockedId;
  const large = MockCommunityRepository.largeId;
  const invited = MockCommunityRepository.invitedId;
  const founder = MockCommunityRepository.founder;

  late DateTime now;
  late MockCommunityRepository repo;

  setUp(() {
    now = DateTime.utc(2026, 9, 26, 12);
    repo = MockCommunityRepository(latency: Duration.zero, clock: () => now);
  });

  Matcher refusedWith(String code) =>
      throwsA(isA<CommunityException>().having((e) => e.code, 'code', code));

  Future<Set<CommunityOperation>> operationsIn(String id) async =>
      (await repo.community(id)).me.operations;

  /// Every member id of [id]'s roster in [server], walked to the end.
  Future<List<String>> roster(MockCommunityRepository server, String id) async {
    final ids = <String>[];
    String? cursor;
    do {
      final page = await server.members(id, cursor: cursor);
      ids.addAll(page.items.map((m) => m.userId));
      cursor = page.nextCursor;
    } while (cursor != null);
    return ids;
  }

  group('me.operations, as the server decides each', () {
    test('the owner: links, grants, handing over — never leaving', () async {
      expect(await operationsIn(owned), {
        CommunityOperation.invitationsManage,
        CommunityOperation.grantsManage,
        CommunityOperation.ownershipTransfer,
      });
    });

    test('a member, a delegate of the roster, a LOCKED one: leaving', () async {
      for (final id in [open, delegated, large, lockedOne]) {
        expect(await operationsIn(id), {CommunityOperation.leave}, reason: id);
      }
    });

    test('a delegate holding members.invite: its links too — while LOCKED '
        'as well, though it makes no new one then', () async {
      repo.delegate(open, {CommunityCapability.membersInvite});
      expect(await operationsIn(open), {
        CommunityOperation.invitationsManage,
        CommunityOperation.leave,
      });
      repo.changeStatus(open, CommunityStatus.locked);
      final locked = await repo.community(open);
      expect(locked.me.operations, {
        CommunityOperation.invitationsManage,
        CommunityOperation.leave,
      });
      expect(locked.me.has(CommunityCapability.membersInvite), isFalse);
    });

    test('LOCKED keeps the owner’s operations', () async {
      repo.changeStatus(owned, CommunityStatus.locked);
      expect(await operationsIn(owned), hasLength(3));
    });
  });

  group('links', () {
    test(
      'are made on the server’s default terms, a new one each time',
      () async {
        final first = await repo.createInvitation(owned);
        final second = await repo.createInvitation(owned);
        for (final created in [first, second]) {
          expect(created.token, matches(RegExp(r'^[A-Za-z0-9_-]{43}$')));
          expect(isInvitationTokenShaped(created.token), isTrue);
          final link = created.invitation;
          expect(link.createdBy, MockCommunityRepository.viewer);
          expect(link.createdAt, now);
          expect(link.expiresAt, now.add(const Duration(days: 7)));
          expect(link.maxUses, isNull);
          expect(link.uses, 0);
          expect(link.state, InvitationState.active);
          expect(link.origin, DataOrigin.mock);
        }
        expect(first.token, isNot(second.token));
        expect(first.invitation.id, isNot(second.invitation.id));
        expect('$first', isNot(contains(first.token)));
      },
    );

    test('are listed newest first, in every state, never a token', () async {
      final made = await repo.createInvitation(owned);
      final page = await repo.invitations(owned);
      expect(page.items.first.id, made.invitation.id);
      expect(page.items.map((i) => i.state), [
        InvitationState.active,
        InvitationState.active,
        InvitationState.expired,
      ]);
      expect(page.items.every((i) => i.origin == DataOrigin.mock), isTrue);
      expect(page.nextCursor, isNull);
    });

    test('derive their state from the clock, as the server does', () async {
      final made = await repo.createInvitation(owned);
      now = now.add(const Duration(days: 7)); // now ≥ expiry: expired
      final expired = (await repo.invitations(owned)).items.first;
      expect(expired.id, made.invitation.id);
      expect(expired.state, InvitationState.expired);
      // Revoked outranks expired.
      final revoked = await repo.revokeInvitation(owned, expired.id);
      expect(revoked.state, InvitationState.revoked);
      expect(revoked.revokedAt, now);
    });

    test('are revoked once: again is the same answer', () async {
      final made = await repo.createInvitation(owned);
      final first = await repo.revokeInvitation(owned, made.invitation.id);
      now = now.add(const Duration(hours: 1));
      final again = await repo.revokeInvitation(owned, made.invitation.id);
      expect(first.state, InvitationState.revoked);
      expect(again.state, InvitationState.revoked);
      expect(again.revokedAt, first.revokedAt);
    });

    test(
      'are made by holders of members.invite, and none while LOCKED',
      () async {
        await expectLater(
          repo.createInvitation(open),
          throwsA(
            isA<CommunityException>()
                .having(
                  (e) => e.code,
                  'code',
                  'communities.capability_required',
                )
                .having(
                  (e) => e.details['act'],
                  'act',
                  'community.members.invite',
                ),
          ),
        );
        repo.delegate(open, {CommunityCapability.membersInvite});
        expect(
          (await repo.createInvitation(open)).invitation.state,
          InvitationState.active,
        );

        for (final id in [owned, open]) {
          repo.changeStatus(id, CommunityStatus.locked);
          await expectLater(
            repo.createInvitation(id),
            throwsA(
              isA<CommunityException>()
                  .having((e) => e.isLocked, 'locked', isTrue)
                  .having(
                    (e) => e.details['act'],
                    'act',
                    'community.members.invite',
                  ),
            ),
          );
        }
        await expectLater(
          repo.createInvitation(invited),
          refusedWith('communities.community_not_found'),
        );
      },
    );

    test(
      'are listed and revoked by whoever manages them — LOCKED too',
      () async {
        for (final id in [open, delegated]) {
          await expectLater(
            repo.invitations(id),
            refusedWith('communities.capability_required'),
          );
          await expectLater(
            repo.revokeInvitation(id, 'anything'),
            refusedWith('communities.capability_required'),
          );
        }
        repo.changeStatus(owned, CommunityStatus.locked);
        final links = (await repo.invitations(owned)).items;
        expect(links, hasLength(2));
        final revoked = await repo.revokeInvitation(owned, links.first.id);
        expect(revoked.state, InvitationState.revoked);

        repo.delegate(open, {CommunityCapability.membersInvite});
        repo.changeStatus(open, CommunityStatus.locked);
        expect((await repo.invitations(open)).items, isEmpty);
      },
    );

    test('are this community’s only', () async {
      final elsewhere = (await repo.invitations(owned)).items.first;
      repo.delegate(open, {CommunityCapability.membersInvite});
      await expectLater(
        repo.revokeInvitation(open, elsewhere.id),
        refusedWith('communities.invitation_not_found'),
      );
      await expectLater(
        repo.revokeInvitation(owned, 'no-such-link'),
        refusedWith('communities.invitation_not_found'),
      );
    });

    test(
      'page by keyset: a link made meanwhile shifts no later page',
      () async {
        final small = MockCommunityRepository(
          latency: Duration.zero,
          invitationPageSize: 2,
          clock: () => now,
        );
        for (var i = 0; i < 3; i++) {
          await small.createInvitation(owned);
        }
        final first = await small.invitations(owned);
        expect(first.items, hasLength(2));
        await small.createInvitation(owned); // newer than every page
        final seen = [...first.items.map((i) => i.id)];
        String? cursor = first.nextCursor;
        while (cursor != null) {
          final page = await small.invitations(owned, cursor: cursor);
          seen.addAll(page.items.map((i) => i.id));
          cursor = page.nextCursor;
        }
        expect(seen, hasLength(5)); // the 2 seeded and the first 3 made
        expect(seen.toSet(), hasLength(5));

        await expectLater(
          small.invitations(owned, cursor: 'forged'),
          refusedWith('communities.cursor_invalid'),
        );
        small.delegate(open, {CommunityCapability.membersInvite});
        await expectLater(
          small.invitations(open, cursor: first.nextCursor),
          refusedWith('communities.cursor_invalid'),
        );
      },
    );
  });

  group('joining by link, in the server’s order', () {
    test(
      'a community the viewer is not in exists for them only by link',
      () async {
        expect(
          (await repo.communities()).items.map((c) => c.id),
          isNot(contains(invited)),
        );
        await expectLater(
          repo.community(invited),
          refusedWith('communities.community_not_found'),
        );
        await expectLater(
          repo.members(invited),
          refusedWith('communities.community_not_found'),
        );
      },
    );

    test(
      'joins with an admitting link: a member, counted, at the top',
      () async {
        final joined = await repo.join(MockCommunityRepository.demoActiveToken);
        expect(joined.id, invited);
        expect(joined.memberCount, 41);
        expect(joined.me.standing, CommunityStanding.member);
        expect(joined.me.joinedAt, now);
        expect(joined.me.capabilities, isEmpty);
        expect(joined.me.operations, {CommunityOperation.leave});
        expect(joined.canOpenChat, isTrue);
        expect((await repo.communities()).items.first.id, invited);
        expect((await repo.community(invited)).memberCount, 41);

        // Again: a member already — the community, and no use taken.
        final again = await repo.join(MockCommunityRepository.demoActiveToken);
        expect(again.memberCount, 41);
        repo.delegate(invited, {CommunityCapability.membersInvite});
        final links = (await repo.invitations(invited)).items;
        expect(links.map((l) => (l.state, l.uses)), [
          (InvitationState.active, 3),
          (InvitationState.revoked, 1),
          (InvitationState.exhausted, 5),
          (InvitationState.expired, 6),
        ]);
        expect(links.every((l) => l.createdBy == founder), isTrue);
      },
    );

    test('refuses a token of the wrong shape, or unknown, alike', () async {
      for (final token in [
        '',
        'short',
        '${MockCommunityRepository.demoActiveToken}0',
        MockCommunityRepository.demoActiveToken.replaceFirst('D', '+'),
        'A' * 43,
      ]) {
        await expectLater(
          repo.join(token),
          refusedWith('communities.invitation_invalid'),
          reason: token,
        );
      }
    });

    test('refuses a link that no longer admits — the server’s codes', () async {
      for (final (token, code) in [
        (
          MockCommunityRepository.demoExpiredToken,
          'communities.invitation_expired',
        ),
        (
          MockCommunityRepository.demoRevokedToken,
          'communities.invitation_revoked',
        ),
        (
          MockCommunityRepository.demoExhaustedToken,
          'communities.invitation_exhausted',
        ),
      ]) {
        await expectLater(repo.join(token), refusedWith(code), reason: token);
      }
      // A link is read against the clock when it is used.
      now = now.add(const Duration(days: 29));
      await expectLater(
        repo.join(MockCommunityRepository.demoActiveToken),
        refusedWith('communities.invitation_expired'),
      );
    });

    test(
      'suspends links while LOCKED — a link’s own state is asked first',
      () async {
        repo.changeStatus(invited, CommunityStatus.locked);
        await expectLater(
          repo.join(MockCommunityRepository.demoActiveToken),
          refusedWith('communities.community_locked'),
        );
        await expectLater(
          repo.join(MockCommunityRepository.demoExpiredToken),
          refusedWith('communities.invitation_expired'),
        );
        repo.changeStatus(invited, CommunityStatus.open);
        final joined = await repo.join(MockCommunityRepository.demoActiveToken);
        expect(joined.memberCount, 41); // the refusals took no use, no seat
      },
    );

    test('takes a member already before any state of the link', () async {
      final made = await repo.createInvitation(owned);
      await repo.revokeInvitation(owned, made.invitation.id);
      final answer = await repo.join(made.token);
      expect(answer.id, owned);
      expect(answer.me.standing, CommunityStanding.owner);
      final link = (await repo.invitations(owned)).items.first;
      expect(link.uses, 0);
    });

    test('lets someone who left back in, never someone removed', () async {
      await repo.join(MockCommunityRepository.demoActiveToken);
      await repo.leave(invited);
      final back = await repo.join(MockCommunityRepository.demoActiveToken);
      expect(back.memberCount, 41);
      expect((await repo.communities()).items.first.id, invited);

      repo.endMembership(invited, removed: true);
      for (final token in [
        MockCommunityRepository.demoActiveToken,
        // Removed is asked before the link's state.
        MockCommunityRepository.demoExpiredToken,
      ]) {
        await expectLater(
          repo.join(token),
          refusedWith('communities.rejoin_requires_manager'),
        );
      }
    });

    test('never says the token in a refusal', () async {
      for (final token in [
        MockCommunityRepository.demoExpiredToken,
        MockCommunityRepository.demoRevokedToken,
        MockCommunityRepository.demoExhaustedToken,
        'A' * 43,
        'not-a-token',
      ]) {
        try {
          await repo.join(token);
          fail('joined through a refused link');
        } on CommunityException catch (error) {
          expect(
            '$error ${error.message} ${error.details}',
            isNot(contains(token)),
          );
        }
      }
    });
  });

  group('removing a member', () {
    Future<String> someoneIn(String id) async =>
        (await repo.members(id)).items[3].userId;

    test('needs members.remove', () async {
      repo.delegate(open, {CommunityCapability.membersView});
      final target = await someoneIn(open);
      await expectLater(
        repo.removeMember(open, target),
        refusedWith('communities.capability_required'),
      );
      await expectLater(
        repo.removeMember(invited, target),
        refusedWith('communities.community_not_found'),
      );
    });

    test('takes an ACTIVE member only', () async {
      final target = await someoneIn(owned);
      await repo.removeMember(owned, target);
      for (final nobody in [
        target, // removed already: a repeat is 404, as on the server
        'nobody',
        '$owned-member-07',
        '$owned-member-12',
        '$open-member-3',
        '$founder-3',
        founder, // not in the viewer's own community
      ]) {
        await expectLater(
          repo.removeMember(owned, nobody),
          refusedWith('communities.member_not_found'),
          reason: nobody,
        );
      }
    });

    test('never the owner — asked before oneself — nor oneself', () async {
      await expectLater(
        repo.removeMember(owned, MockCommunityRepository.viewer),
        refusedWith('communities.owner_not_removable'),
      );
      repo.delegate(open, {
        CommunityCapability.membersView,
        CommunityCapability.membersRemove,
      });
      await expectLater(
        repo.removeMember(open, founder),
        refusedWith('communities.owner_not_removable'),
      );
      await expectLater(
        repo.removeMember(open, MockCommunityRepository.viewer),
        refusedWith('communities.cannot_remove_self'),
      );
      await repo.removeMember(open, await someoneIn(open));
    });

    test('by a delegate: nobody holding a capability it lacks', () async {
      // The viewer hands its community to one teacher, keeping another's
      // grant.
      final teachers = [
        for (final m in (await repo.members(owned)).items)
          if (m.userId.startsWith('$founder-')) m.userId,
      ];
      expect(teachers, hasLength(2));
      final [heir, holder] = teachers;
      await repo.grant(
        owned,
        userId: holder,
        capabilities: {CommunityCapability.lock},
      );
      await repo.transferOwnership(owned, heir);
      repo.delegate(owned, {CommunityCapability.membersRemove});
      await expectLater(
        repo.removeMember(owned, holder),
        refusedWith('communities.member_holds_more_capabilities'),
      );
      await expectLater(
        repo.removeMember(owned, heir),
        refusedWith('communities.owner_not_removable'),
      );
      repo.delegate(owned, {
        CommunityCapability.membersRemove,
        CommunityCapability.lock,
      });
      await repo.removeMember(owned, holder);
    });

    test('counts one fewer, and ends the member’s grants', () async {
      final teacher = (await repo.members(owned)).items
          .firstWhere((m) => m.userId.startsWith('$founder-'))
          .userId;
      expect(
        (await repo.grants(
          owned,
          userId: teacher,
        )).items.map((g) => g.capability),
        [CommunityCapability.membersView],
      );
      await repo.removeMember(owned, teacher);
      expect((await repo.community(owned)).memberCount, 11);
      expect((await repo.grants(owned, userId: teacher)).items, isEmpty);
      expect((await roster(repo, owned)), isNot(contains(teacher)));
    });

    test('keeps a 30,000-member roster lazy: nothing built to remove, '
        'nobody built twice, and cursors that still mean their row', () async {
      repo.delegate(large, {
        CommunityCapability.membersView,
        CommunityCapability.membersRemove,
      });
      final first = await repo.members(large);
      final second = await repo.members(large, cursor: first.nextCursor);
      expect(repo.membersBuilt, 100);

      // Three from the first page, one from the next — and the far end.
      final gone = {
        first.items[4].userId,
        first.items[5].userId,
        first.items[49].userId,
        second.items[0].userId,
        '$large-member-15000',
        '$large-member-29999',
      };
      for (final id in gone) {
        await repo.removeMember(large, id);
      }
      expect(repo.membersBuilt, 100); // removing built nothing
      expect((await repo.community(large)).memberCount, 30000 - 6);

      // A cursor issued before the removals starts where it did.
      final afterFirst = await repo.members(large, cursor: first.nextCursor);
      expect(afterFirst.items, hasLength(50));
      expect(afterFirst.items.first.userId, second.items[1].userId);
      expect(repo.membersBuilt, 150);

      final before = repo.membersBuilt;
      final ids = await roster(repo, large);
      expect(ids, hasLength(30000 - 6));
      expect(ids.toSet(), hasLength(30000 - 6));
      expect(ids.toSet().intersection(gone), isEmpty);
      // Built exactly what was shown: removed rows are passed over unbuilt.
      expect(repo.membersBuilt - before, 30000 - 6);
    });

    test('ends the last page where the last member is', () async {
      final small = MockCommunityRepository(
        latency: Duration.zero,
        memberPageSize: 5,
      );
      // Rows 0–11: pages 0–4, 5–9, 10–11. Without 10 and 11, the second
      // page is the last.
      for (final row in [10, 11]) {
        await small.removeMember(owned, '$owned-member-$row');
      }
      final firstPage = await small.members(owned);
      final secondPage = await small.members(
        owned,
        cursor: firstPage.nextCursor,
      );
      expect(secondPage.items, hasLength(5));
      expect(secondPage.nextCursor, isNull);
      expect(await roster(small, owned), hasLength(10));
    });
  });

  group('leaving', () {
    test('is not the owner’s', () async {
      await expectLater(
        repo.leave(owned),
        refusedWith('communities.owner_cannot_leave'),
      );
      expect(
        (await repo.community(owned)).me.standing,
        CommunityStanding.owner,
      );
    });

    test('ends the stint: gone from the list, and "not found" after', () async {
      for (final id in [open, lockedOne]) {
        await repo.leave(id);
        await expectLater(
          repo.community(id),
          refusedWith('communities.community_not_found'),
        );
        await expectLater(
          repo.leave(id),
          refusedWith('communities.community_not_found'),
        );
      }
      expect((await repo.communities()).items.map((c) => c.id), [
        owned,
        delegated,
        large,
      ]);
    });

    test('ends what was delegated with the stint', () async {
      await repo.leave(delegated);
      repo.restoreMembership(delegated);
      final back = await repo.community(delegated);
      expect(back.me.capabilities, isEmpty);
      expect(back.canViewMembers, isFalse);
    });
  });

  group('locking and unlocking', () {
    test('need community.lock', () async {
      await expectLater(
        repo.lock(open),
        refusedWith('communities.capability_required'),
      );
      await expectLater(
        repo.unlock(lockedOne),
        refusedWith('communities.capability_required'),
      );
      await expectLater(
        repo.lock(invited),
        refusedWith('communities.community_not_found'),
      );
    });

    test('change the version on a real change only', () async {
      final before = (await repo.community(owned)).lifecycleVersion;
      final locked = await repo.lock(owned);
      expect(locked.isLocked, isTrue);
      expect(locked.lifecycleVersion, before + 1);
      expect(locked.me.has(CommunityCapability.lock), isTrue);
      expect(locked.me.has(CommunityCapability.chatPost), isFalse);
      expect((await repo.lock(owned)).lifecycleVersion, before + 1);

      final unlocked = await repo.unlock(owned);
      expect(unlocked.isLocked, isFalse);
      expect(unlocked.lifecycleVersion, before + 2);
      expect((await repo.unlock(owned)).lifecycleVersion, before + 2);
    });

    test('are a delegate’s too, when community.lock was delegated', () async {
      repo.delegate(lockedOne, {CommunityCapability.lock});
      expect((await repo.unlock(lockedOne)).isLocked, isFalse);
      expect((await repo.lock(lockedOne)).isLocked, isTrue);
    });
  });

  group('grants', () {
    Future<String> member(String id, int index) async =>
        (await repo.members(id)).items[index].userId;

    test(
      'are shown whole to the owner, and to anyone else their own',
      () async {
        final teacher = await member(owned, 2);
        final shown = (await repo.grants(owned, userId: teacher)).items;
        expect(shown.single.capability, CommunityCapability.membersView);
        expect(shown.single.userId, teacher);
        expect(shown.single.grantedBy, MockCommunityRepository.viewer);
        expect(shown.single.dormant, isFalse);
        expect(shown.single.origin, DataOrigin.mock);

        final own = (await repo.grants(
          delegated,
          userId: MockCommunityRepository.viewer,
        )).items;
        expect(own.single.capability, CommunityCapability.membersView);
        expect(own.single.grantedBy, founder);
        expect((await repo.grants(delegated, userId: founder)).items, isEmpty);
        await expectLater(
          repo.grants(invited, userId: founder),
          refusedWith('communities.community_not_found'),
        );
      },
    );

    test('are the owner’s to make', () async {
      await expectLater(
        repo.grant(
          delegated,
          userId: founder,
          capabilities: {CommunityCapability.lock},
        ),
        refusedWith('communities.not_community_owner'),
      );
      await expectLater(
        repo.revokeGrant(delegated, 'any'),
        refusedWith('communities.not_community_owner'),
      );
    });

    test('go to a member whose account may hold them — in the mock, its '
        'teachers — and every refusal reads alike', () async {
      final roster = (await repo.members(owned)).items;
      final student = roster[1];
      expect(student.active, isTrue);
      final teacher = roster[9];
      expect(teacher.userId, '$founder-9');
      final removedTeacher = roster[2].userId;
      await repo.removeMember(owned, removedTeacher);

      final refusals = <CommunityException>[];
      for (final grantee in [
        student.userId, // a student's account holds no ceiling
        '$owned-member-11', // an account that cannot sign in
        removedTeacher, // no longer a member
        'nobody',
        '$founder-27', // no such row in a community of twelve
        MockCommunityRepository.viewer, // the owner, and oneself
      ]) {
        try {
          await repo.grant(
            owned,
            userId: grantee,
            capabilities: {CommunityCapability.lock},
          );
          fail('granted to $grantee');
        } on CommunityException catch (error) {
          refusals.add(error);
        }
      }
      expect({
        for (final e in refusals) (e.code, e.message, e.details),
      }, hasLength(1));
      expect(refusals.first.code, 'communities.grantee_ineligible');
      expect(roster.last.active, isFalse); // row 11: the inactive account

      final change = await repo.grant(
        owned,
        userId: teacher.userId,
        capabilities: {CommunityCapability.lock},
      );
      expect(change.created.single.userId, teacher.userId);
    });

    test('were seeded for the viewer, a student: data, not a route’s '
        'grant — and the test mutator still delegates', () async {
      expect((await repo.community(delegated)).me.capabilities, {
        CommunityCapability.membersView,
      });
      repo.delegate(open, {CommunityCapability.lock});
      expect((await repo.community(open)).me.capabilities, {
        CommunityCapability.lock,
      });
    });

    test(
      'keep what is held, and list both in the vocabulary’s order',
      () async {
        final teacher = await member(owned, 2);
        final change = await repo.grant(
          owned,
          userId: teacher,
          capabilities: {
            CommunityCapability.lock,
            CommunityCapability.membersView,
            CommunityCapability.membersInvite,
          },
        );
        expect(change.created.map((g) => g.capability), [
          CommunityCapability.membersInvite,
          CommunityCapability.lock,
        ]);
        expect(change.unchanged.map((g) => g.capability), [
          CommunityCapability.membersView,
        ]);
        final again = await repo.grant(
          owned,
          userId: teacher,
          capabilities: {CommunityCapability.lock},
        );
        expect(again.created, isEmpty);
        expect(again.unchanged.single.grantId, change.created.last.grantId);
        // Listed by the capability's name, as the server orders them.
        expect(
          (await repo.grants(
            owned,
            userId: teacher,
          )).items.map((g) => g.capability.wire),
          [
            'community.lock',
            'community.members.invite',
            'community.members.view',
          ],
        );
      },
    );

    test('are refused as the route refuses a malformed request', () async {
      final teacher = await member(owned, 2);
      for (final capabilities in [
        <CommunityCapability>{},
        {CommunityCapability.unknown},
        {CommunityCapability.lock, CommunityCapability.unknown},
      ]) {
        await expectLater(
          repo.grant(owned, userId: teacher, capabilities: capabilities),
          refusedWith('bad_request'),
        );
      }
    });

    test(
      'are revoked once — again changes nothing — and unknown is 404',
      () async {
        final teacher = await member(owned, 2);
        final grant = (await repo.grants(owned, userId: teacher)).items.single;
        await repo.revokeGrant(owned, grant.grantId);
        await repo.revokeGrant(owned, grant.grantId);
        expect((await repo.grants(owned, userId: teacher)).items, isEmpty);
        await expectLater(
          repo.revokeGrant(owned, 'no-such-grant'),
          refusedWith('communities.grant_not_found'),
        );
        // Granting again is a new grant.
        final back = await repo.grant(
          owned,
          userId: teacher,
          capabilities: {CommunityCapability.membersView},
        );
        expect(back.created.single.grantId, isNot(grant.grantId));
      },
    );

    test('page by a cursor issued for that member alone', () async {
      final teacher = await member(owned, 2);
      final page = await repo.grants(owned, userId: teacher);
      expect(page.nextCursor, isNull);
      await expectLater(
        repo.grants(owned, userId: teacher, cursor: 'forged'),
        refusedWith('communities.cursor_invalid'),
      );
    });

    test('are what the viewer holds: me follows its grants', () async {
      repo.delegate(open, {
        CommunityCapability.membersView,
        CommunityCapability.lock,
      });
      expect((await repo.community(open)).me.capabilities, {
        CommunityCapability.membersView,
        CommunityCapability.lock,
      });
      expect(
        (await repo.grants(open, userId: MockCommunityRepository.viewer)).items,
        hasLength(2),
      );
      repo.delegate(open, {CommunityCapability.lock});
      expect((await repo.community(open)).me.capabilities, {
        CommunityCapability.lock,
      });
    });
  });

  group('handing the community over', () {
    Future<String> teacherIn(String id) async =>
        (await repo.members(id)).items
            .firstWhere((m) => m.userId.startsWith('$founder-'))
            .userId;

    test('is the owner’s', () async {
      await expectLater(
        repo.transferOwnership(delegated, founder),
        refusedWith('communities.not_community_owner'),
      );
    });

    test('goes to a member the mock lets own — its teachers — only', () async {
      final roster = (await repo.members(owned)).items;
      final student = roster[1].userId;
      final removed = roster[3].userId;
      await repo.removeMember(owned, removed);
      for (final target in [
        student,
        removed,
        'nobody',
        '$founder-27', // no such row in a community of twelve
      ]) {
        await expectLater(
          repo.transferOwnership(owned, target),
          refusedWith('communities.owner_ineligible'),
          reason: target,
        );
      }
      // Naming the owner — the viewer — changes nothing.
      final same = await repo.transferOwnership(
        owned,
        MockCommunityRepository.viewer,
      );
      expect(same.me.standing, CommunityStanding.owner);
    });

    test('leaves the former owner a member holding nothing', () async {
      final heir = await teacherIn(owned);
      repo.changeStatus(owned, CommunityStatus.locked); // no gate on it
      final after = await repo.transferOwnership(owned, heir);
      expect(after.me.standing, CommunityStanding.member);
      expect(after.me.capabilities, isEmpty);
      expect(after.me.operations, {CommunityOperation.leave});
      expect(after.memberCount, 12);
      // Grants are no longer the former owner's to see: their own only.
      expect((await repo.grants(owned, userId: heir)).items, isEmpty);
      await expectLater(
        repo.grant(
          owned,
          userId: heir,
          capabilities: {CommunityCapability.lock},
        ),
        refusedWith('communities.not_community_owner'),
      );
      // And the former owner may now leave.
      await repo.leave(owned);
      await expectLater(
        repo.community(owned),
        refusedWith('communities.community_not_found'),
      );
    });
  });

  group('the scripted server', () {
    test('records each write — a join without its token — and holds or '
        'refuses it on request', () async {
      final scripted = ScriptedCommunities();
      await scripted.join(MockCommunityRepository.demoActiveToken);
      await scripted.lock(owned);
      expect(scripted.writes, ['join', 'lock $owned']);
      expect(
        scripted.writes.join(' '),
        isNot(contains(MockCommunityRepository.demoActiveToken)),
      );

      scripted.failWritesWith = 'communities.conflict';
      await expectLater(
        scripted.unlock(owned),
        refusedWith('communities.conflict'),
      );
      expect((await scripted.community(owned)).isLocked, isTrue);
      scripted.failWritesWith = null;

      // Done at once; its answer handed over only when released.
      final hold = scripted.holdWrites = Completer<void>();
      var answered = false;
      final unlocking = scripted.unlock(owned).then((_) => answered = true);
      await pumpEventQueue();
      expect((await scripted.community(owned)).isLocked, isFalse);
      expect(answered, isFalse);
      hold.complete();
      await unlocking;
      expect(answered, isTrue);

      await scripted.invitations(owned);
      await scripted.grants(owned, userId: MockCommunityRepository.viewer);
      expect(scripted.invitationCursors, [null]);
      expect(scripted.grantRequests, [MockCommunityRepository.viewer]);
    });
  });
}

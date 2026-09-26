import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override, ProviderBase;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/features/communities/state/community_controller.dart';
import 'package:quran_institution_app/features/communities/state/community_invitations_controller.dart';
import 'package:quran_institution_app/features/communities/state/community_list_controller.dart';
import 'package:quran_institution_app/features/communities/state/community_members_controller.dart';
import 'package:quran_institution_app/features/communities/state/community_write.dart';
import 'package:quran_institution_app/features/communities/state/member_grants_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';
import 'community_test_support.dart';

/// A change on its way while the screen that sent it is refreshed, rebuilt,
/// left or opened again. Whatever the viewer does meanwhile:
///
///   - a refresh reads again without starting the screen over: a change on
///     its way is still seen through by the same controller, and a change
///     asked for during the refresh is sent;
///   - a change never disposes a screen opened after it, and never leaves
///     one dead;
///   - once the server has answered, what the change touched is read again
///     wherever it is still shown — even when the screen that sent it is
///     gone;
///   - a next page asked for before a refresh is never spliced onto what
///     the refresh read.
void main() {
  const open = MockCommunityRepository.openId;
  const owned = MockCommunityRepository.ownedId;
  const founder = MockCommunityRepository.founder;
  const teacher = '$founder-2';
  const student = '$owned-member-3';
  const grantKey = (communityId: owned, userId: teacher);

  late ScriptedCommunities repo;
  late FakeRealtimeClient realtime;
  late ProviderContainer container;

  void boot() {
    container = ProviderContainer(
      overrides: [
        communityRepositoryProvider.overrideWithValue(repo),
        messagingRepositoryProvider.overrideWithValue(ScriptedMessaging()),
        realtimeConnectionProvider.overrideWithValue(realtime),
      ],
    );
    addTearDown(container.dispose);
  }

  setUp(() {
    repo = ScriptedCommunities();
    realtime = FakeRealtimeClient();
    boot();
  });

  void keep(ProviderBase<Object?> provider) {
    final subscription = container.listen(provider, (_, _) {});
    addTearDown(subscription.close);
  }

  Community detail(String id) =>
      container.read(communityProvider(id)).requireValue.community!;

  Community row(String id) => container
      .read(communityListProvider)
      .requireValue
      .items
      .firstWhere((c) => c.id == id);

  List<String> listed() => [
    for (final c in container.read(communityListProvider).requireValue.items)
      c.id,
  ];

  CommunityController detailOf(String id) =>
      container.read(communityProvider(id).notifier);

  CommunityMembersController rosterOf(String id) =>
      container.read(communityMembersProvider(id).notifier);

  CommunityInvitationsController linksOf(String id) =>
      container.read(communityInvitationsProvider(id).notifier);

  MemberGrantsController grantsOf(MemberKey key) =>
      container.read(memberGrantsProvider(key).notifier);

  String activeLink() => container
      .read(communityInvitationsProvider(owned))
      .requireValue
      .items
      .firstWhere((i) => i.state == InvitationState.active)
      .id;

  /// Each change the management screens send, with the screen's provider,
  /// its refresh, and the reads it makes (to tell a live screen).
  final writes =
      <
        (
          String,
          ProviderBase<Object?>,
          Future<Object?> Function(),
          Future<void> Function(),
          int Function(),
        )
      >[
        (
          'a removal',
          communityMembersProvider(owned),
          () => rosterOf(owned).remove(student),
          () => rosterOf(owned).refresh(),
          () => repo.memberCursors.length,
        ),
        (
          'a lock',
          communityProvider(owned),
          () => detailOf(owned).lock(),
          () => detailOf(owned).refresh(),
          () => repo.communityRequests.length,
        ),
        (
          'a new link',
          communityInvitationsProvider(owned),
          () => linksOf(owned).create(),
          () => linksOf(owned).refresh(),
          () => repo.invitationCursors.length,
        ),
        (
          'a revoked link',
          communityInvitationsProvider(owned),
          () => linksOf(owned).revoke(activeLink()),
          () => linksOf(owned).refresh(),
          () => repo.invitationCursors.length,
        ),
        (
          'a grant',
          memberGrantsProvider(grantKey),
          () => grantsOf(grantKey).grant({CommunityCapability.lock}),
          () => grantsOf(grantKey).refresh(),
          () => repo.grantRequests.length,
        ),
      ];

  group('a change on its way, its screen left and opened again', () {
    for (final (name, provider, write, refresh, reads) in writes) {
      Future<ProviderSubscription<Object?>> openScreen() async {
        final subscription = container.listen(provider, (_, _) {});
        await pumpEventQueue();
        return subscription;
      }

      Future<void> expectLive(ProviderSubscription<Object?> screen) async {
        expect(container.exists(provider), isTrue);
        expect(screen.closed, isFalse);
        expect(screen.read, returnsNormally);
        // Live: a frame still reads it again.
        final before = reads();
        realtime.emit(accessChanged(owned));
        await pumpEventQueue();
        expect(reads(), greaterThan(before));
      }

      test('$name, refreshed on its way: the screen opened again before '
          'the answer stays live', () async {
        var screen = await openScreen();
        final hold = repo.holdWrites = Completer<void>();
        final writing = write();
        await pumpEventQueue();
        expect(repo.writes, hasLength(1));
        await refresh(); // the app bar's refresh
        screen.close(); // back
        await pumpEventQueue();
        screen = await openScreen(); // opened again before the answer
        addTearDown(screen.close);
        hold.complete();
        expect(await writing, isA<WriteDone<Object?>>());
        await pumpEventQueue();
        await expectLive(screen);
        expect(repo.writes, hasLength(1));
      });

      test('$name, rebuilt on its way (a dependency changed): the old change '
          'never disposes the screen opened after it', () async {
        var screen = await openScreen();
        final hold = repo.holdWrites = Completer<void>();
        final writing = write();
        await pumpEventQueue();
        container.invalidate(provider);
        await pumpEventQueue();
        screen.close();
        await pumpEventQueue();
        screen = await openScreen();
        addTearDown(screen.close);
        hold.complete();
        await writing;
        await pumpEventQueue();
        await expectLive(screen);
      });
    }
  });

  group('a change on its way, its screen left: what it touched follows', () {
    for (final rebuilt in [false, true]) {
      final how = rebuilt ? 'rebuilt' : 'refreshed';

      test('a removal $how, then left: the count on the community and in '
          'the list', () async {
        keep(communityProvider(owned));
        keep(communityListProvider);
        await container.read(communityProvider(owned).future);
        await container.read(communityListProvider.future);
        final roster = container.listen(
          communityMembersProvider(owned),
          (_, _) {},
        );
        await container.read(communityMembersProvider(owned).future);
        final hold = repo.holdWrites = Completer<void>();
        final removing = rosterOf(owned).remove(student);
        await pumpEventQueue();
        if (rebuilt) {
          container.invalidate(communityMembersProvider(owned));
          await pumpEventQueue();
        } else {
          await rosterOf(owned).refresh();
        }
        roster.close(); // back to the community
        await pumpEventQueue();
        hold.complete();
        expect(await removing, isA<WriteDone<void>>());
        await pumpEventQueue();
        expect(detail(owned).memberCount, 11);
        expect(row(owned).memberCount, 11);
      });

      test('a hand-over $how, then left: the viewer’s standing on the '
          'community and in the list', () async {
        keep(communityProvider(owned));
        keep(communityListProvider);
        await container.read(communityProvider(owned).future);
        await container.read(communityListProvider.future);
        final roster = container.listen(
          communityMembersProvider(owned),
          (_, _) {},
        );
        await container.read(communityMembersProvider(owned).future);
        final hold = repo.holdWrites = Completer<void>();
        final handing = rosterOf(owned).transferOwnership(teacher);
        await pumpEventQueue();
        if (rebuilt) {
          container.invalidate(communityMembersProvider(owned));
          await pumpEventQueue();
        } else {
          await rosterOf(owned).refresh();
        }
        roster.close();
        await pumpEventQueue();
        hold.complete();
        expect(await handing, isA<WriteDone<void>>());
        await pumpEventQueue();
        expect(detail(owned).me.standing, CommunityStanding.member);
        expect(row(owned).me.standing, CommunityStanding.member);
      });

      test('a lock $how, then left: its row in the list', () async {
        keep(communityListProvider);
        await container.read(communityListProvider.future);
        final screen = container.listen(communityProvider(owned), (_, _) {});
        await container.read(communityProvider(owned).future);
        final hold = repo.holdWrites = Completer<void>();
        final locking = detailOf(owned).lock();
        await pumpEventQueue();
        if (rebuilt) {
          container.invalidate(communityProvider(owned));
          await pumpEventQueue();
        } else {
          await detailOf(owned).refresh();
        }
        screen.close();
        await pumpEventQueue();
        hold.complete();
        expect(await locking, isA<WriteDone<void>>());
        await pumpEventQueue();
        expect(row(owned).isLocked, isTrue);
      });

      test('a leave $how, then left: out of the list', () async {
        keep(communityListProvider);
        await container.read(communityListProvider.future);
        final screen = container.listen(communityProvider(open), (_, _) {});
        await container.read(communityProvider(open).future);
        final hold = repo.holdWrites = Completer<void>();
        final leaving = detailOf(open).leave();
        await pumpEventQueue();
        if (rebuilt) {
          container.invalidate(communityProvider(open));
          await pumpEventQueue();
        } else {
          await detailOf(open).refresh();
        }
        screen.close();
        await pumpEventQueue();
        hold.complete();
        expect(await leaving, isA<WriteDone<void>>());
        await pumpEventQueue();
        expect(listed(), isNot(contains(open)));
      });
    }
  });

  group('a next page asked for before a refresh', () {
    test('of links: dropped — the links between stay reachable', () async {
      repo = ScriptedCommunities(invitationPageSize: 1);
      boot();
      keep(communityInvitationsProvider(owned));
      await container.read(communityInvitationsProvider(owned).future);
      List<String> ids() => [
        for (final i
            in container
                .read(communityInvitationsProvider(owned))
                .requireValue
                .items)
          i.id,
      ];
      final shownFirst = ids().single;
      // The next page takes its answer, cut after the link shown...
      final stalePage = repo.holdInvitations = Completer<void>();
      final more = linksOf(owned).loadMore();
      await pumpEventQueue();
      repo.holdInvitations = null;
      // ...another manager makes a link, and the refresh lands first.
      final made = await repo.createInvitation(owned);
      await linksOf(owned).refresh();
      stalePage.complete();
      await more;
      final links = container
          .read(communityInvitationsProvider(owned))
          .requireValue;
      expect(ids(), [made.invitation.id]);
      expect(links.hasMore, isTrue);
      expect(links.loadingMore, isFalse);
      while (container
          .read(communityInvitationsProvider(owned))
          .requireValue
          .hasMore) {
        await linksOf(owned).loadMore();
      }
      expect(ids(), contains(shownFirst));
      expect(ids(), hasLength(3));
    });

    test('of the roster: dropped — a member removed meanwhile is not '
        'spliced back', () async {
      repo = ScriptedCommunities(memberPageSize: 5);
      boot();
      keep(communityMembersProvider(owned));
      await container.read(communityMembersProvider(owned).future);
      const gone = '$owned-member-7'; // on the second page
      final stalePage = repo.holdMembers = Completer<void>();
      final more = rosterOf(owned).loadMore();
      await pumpEventQueue();
      repo.holdMembers = null;
      await repo.removeMember(owned, gone); // by another manager
      await rosterOf(owned).refresh();
      stalePage.complete();
      await more;
      final roster = container
          .read(communityMembersProvider(owned))
          .requireValue;
      expect(roster.items, hasLength(5));
      expect(roster.loadingMore, isFalse);
      while (container
          .read(communityMembersProvider(owned))
          .requireValue
          .hasMore) {
        await rosterOf(owned).loadMore();
      }
      final ids = [
        for (final m
            in container
                .read(communityMembersProvider(owned))
                .requireValue
                .items)
          m.userId,
      ];
      expect(ids, isNot(contains(gone)));
      expect(ids, hasLength(11));
    });

    test('of the communities: dropped — the ones between stay '
        'reachable', () async {
      repo = ScriptedCommunities(communityPageSize: 2);
      repo.endMembership(MockCommunityRepository.largeId);
      boot();
      keep(communityListProvider);
      await container.read(communityListProvider.future);
      expect(listed(), [open, owned]);
      final stalePage = repo.holdList = Completer<void>();
      final more = container.read(communityListProvider.notifier).loadMore();
      await pumpEventQueue();
      repo.holdList = null;
      // Joined elsewhere (no frame), then the list refreshed.
      repo.restoreMembership(MockCommunityRepository.largeId);
      await container.read(communityListProvider.notifier).refresh();
      stalePage.complete();
      await more;
      expect(listed(), [MockCommunityRepository.largeId, open]);
      while (container.read(communityListProvider).requireValue.hasMore) {
        await container.read(communityListProvider.notifier).loadMore();
      }
      expect(listed(), contains(owned));
      expect(listed(), hasLength(5));
    });
  });

  group('a confirmed change whose read-back fails', () {
    /// [write] is done at once; every read after its answer fails.
    Future<WriteOutcome<T>> readBackFails<T>(
      Future<WriteOutcome<T>> Function() write,
    ) async {
      final hold = repo.holdWrites = Completer<void>();
      final outcome = write();
      await pumpEventQueue();
      repo.failWith = 'network.unreachable';
      hold.complete();
      return outcome;
    }

    CommunityInvitation link(String id) => container
        .read(communityInvitationsProvider(owned))
        .requireValue
        .items
        .firstWhere((i) => i.id == id);

    Set<CommunityCapability> held() => {
      for (final g
          in container.read(memberGrantsProvider(grantKey)).requireValue.grants)
        g.capability,
    };

    test('a revoked link: shown as the server answered — revoked — and '
        'said not to be read again', () async {
      keep(communityInvitationsProvider(owned));
      await container.read(communityInvitationsProvider(owned).future);
      final target = activeLink();
      final outcome = await readBackFails(() => linksOf(owned).revoke(target));
      expect((outcome as WriteDone<void>).refreshed, isFalse);
      expect(link(target).state, InvitationState.revoked);
      expect(
        container
            .read(communityInvitationsProvider(owned))
            .requireValue
            .revoking,
        isEmpty,
      );
      // Reads back: the refresh shows the server's word.
      repo.failWith = null;
      await linksOf(owned).refresh();
      expect(link(target).state, InvitationState.revoked);
    });

    test('a new link: listed first, as the server answered', () async {
      keep(communityInvitationsProvider(owned));
      await container.read(communityInvitationsProvider(owned).future);
      final outcome = await readBackFails(() => linksOf(owned).create());
      final done = outcome as WriteDone<CreatedInvitation>;
      expect(done.refreshed, isFalse);
      final items = container
          .read(communityInvitationsProvider(owned))
          .requireValue
          .items;
      expect(items.first.id, done.value.invitation.id);
      expect(items, hasLength(3));
    });

    test('a removed member: off the roster', () async {
      keep(communityMembersProvider(owned));
      await container.read(communityMembersProvider(owned).future);
      final outcome = await readBackFails(
        () => rosterOf(owned).remove(student),
      );
      expect((outcome as WriteDone<void>).refreshed, isFalse);
      final roster = container
          .read(communityMembersProvider(owned))
          .requireValue;
      expect(roster.items.map((m) => m.userId), isNot(contains(student)));
      expect(roster.writing, isEmpty);
    });

    test('a lock: shown locked, on the community and in the list', () async {
      keep(communityProvider(owned));
      keep(communityListProvider);
      await container.read(communityProvider(owned).future);
      await container.read(communityListProvider.future);
      final outcome = await readBackFails(() => detailOf(owned).lock());
      expect((outcome as WriteDone<void>).refreshed, isFalse);
      expect(detail(owned).isLocked, isTrue);
      expect(detail(owned).me.has(CommunityCapability.chatPost), isFalse);
      expect(row(owned).isLocked, isTrue);
    });

    test('an unlock: shown open', () async {
      repo.changeStatus(owned, CommunityStatus.locked);
      keep(communityProvider(owned));
      await container.read(communityProvider(owned).future);
      final outcome = await readBackFails(() => detailOf(owned).unlock());
      expect((outcome as WriteDone<void>).refreshed, isFalse);
      expect(detail(owned).isLocked, isFalse);
    });

    test(
      'a hand-over: the viewer’s standing as the server answered it',
      () async {
        keep(communityProvider(owned));
        keep(communityListProvider);
        keep(communityMembersProvider(owned));
        await container.read(communityProvider(owned).future);
        await container.read(communityListProvider.future);
        await container.read(communityMembersProvider(owned).future);
        final outcome = await readBackFails(
          () => rosterOf(owned).transferOwnership(teacher),
        );
        expect((outcome as WriteDone<void>).refreshed, isFalse);
        expect(detail(owned).me.standing, CommunityStanding.member);
        expect(detail(owned).me.operations, {CommunityOperation.leave});
        expect(row(owned).me.standing, CommunityStanding.member);
      },
    );

    test('a grant: what it created, shown granted', () async {
      keep(memberGrantsProvider(grantKey));
      await container.read(memberGrantsProvider(grantKey).future);
      final outcome = await readBackFails(
        () => grantsOf(grantKey).grant({CommunityCapability.lock}),
      );
      expect((outcome as WriteDone<GrantChange>).refreshed, isFalse);
      expect(held(), {
        CommunityCapability.membersView,
        CommunityCapability.lock,
      });
    });

    test('a revoked grant: gone', () async {
      keep(memberGrantsProvider(grantKey));
      await container.read(memberGrantsProvider(grantKey).future);
      final grant = container
          .read(memberGrantsProvider(grantKey))
          .requireValue
          .grantOf(CommunityCapability.membersView)!;
      final outcome = await readBackFails(
        () => grantsOf(grantKey).revoke(grant.grantId),
      );
      expect((outcome as WriteDone<void>).refreshed, isFalse);
      expect(held(), isEmpty);
    });

    test(
      'a lock answered after a newer unlock was shown: the newer stays',
      () async {
        keep(communityProvider(owned));
        await container.read(communityProvider(owned).future);
        final hold = repo.holdWrites = Completer<void>();
        final locking = detailOf(owned).lock(); // done now: version 2
        await pumpEventQueue();
        // Unlocked again by someone else, and told so, before the answer.
        final reopened = repo.changeStatus(owned, CommunityStatus.open);
        realtime.emit(unlocked(owned, reopened));
        await pumpEventQueue();
        expect(detail(owned).lifecycleVersion, reopened);
        repo.failWith = 'network.unreachable';
        hold.complete();
        await locking;
        expect(detail(owned).isLocked, isFalse);
        expect(detail(owned).lifecycleVersion, reopened);
      },
    );

    test('read back as usual, it says so', () async {
      keep(communityInvitationsProvider(owned));
      await container.read(communityInvitationsProvider(owned).future);
      final outcome = await linksOf(owned).revoke(activeLink());
      expect((outcome as WriteDone<void>).refreshed, isTrue);
    });
  });

  group('in the app', () {
    const signedIn = CurrentUser(
      id: viewer,
      displayName: 'طالب تجريبي',
      status: AccountStatus.active,
      roles: [],
      permissions: {},
    );
    const studentName = 'فاطمة الأنصاري';

    Finder options(String? name) => find.byTooltip(
      CommunityCopy.memberOptions(
        CommunityMember(
          userId: 'x',
          displayName: name,
          active: true,
          joinedAt: DateTime.utc(2026),
        ),
      ),
    );

    Finder inDialog(Finder finder) =>
        find.descendant(of: find.byType(AlertDialog), matching: finder);

    Future<ProviderContainer> start(
      WidgetTester tester,
      String path, {
      List<Override> extra = const [],
    }) => openApp(
      tester,
      path,
      size: const Size(390, 2000),
      overrides: [
        communityRepositoryProvider.overrideWithValue(repo),
        messagingRepositoryProvider.overrideWithValue(ScriptedMessaging()),
        sessionUserProvider.overrideWith((ref) async => signedIn),
        realtimeConnectionProvider.overrideWithValue(realtime),
        ...extra,
      ],
    );

    /// Long enough for a page transition to finish, without waiting for
    /// what is held to settle (a spinner never settles).
    Future<void> frames(WidgetTester tester) async {
      for (var i = 0; i < 12; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    Future<void> removeStudent(WidgetTester tester) async {
      await tester.tap(options(studentName));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.removeMember));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.confirmRemove));
      await frames(tester);
    }

    testWidgets('the roster: a removal refreshed on its way, the roster left '
        'and opened again — the roster opened again is live', (tester) async {
      final app = await start(tester, '/communities/$owned');
      await tester.tap(find.text(CommunityCopy.viewMembers));
      await tester.pumpAndSettle();
      final hold = repo.holdWrites = Completer<void>();
      await removeStudent(tester);
      expect(repo.writes, ['removeMember $owned $student']);
      await tester.tap(find.byTooltip(CommunityCopy.refresh).last);
      await frames(tester);
      app.read(routerProvider).pop();
      await frames(tester);
      await tester.tap(find.text(CommunityCopy.viewMembers));
      await frames(tester);
      hold.complete();
      await tester.pumpAndSettle();
      expect(find.text(studentName), findsNothing);

      final reads = repo.memberCursors.length;
      realtime.emit(accessChanged(owned));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(repo.memberCursors.length, greaterThan(reads));

      // Its buttons still send.
      await tester.tap(options(null));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.removeMember));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.confirmRemove));
      await tester.pumpAndSettle();
      expect(repo.writes, hasLength(2));
      expect(tester.takeException(), isNull);
    });

    /// Confirms [confirm] with every read after the change failing.
    Future<void> readBackFails(
      WidgetTester tester,
      Future<void> Function() confirm,
    ) async {
      final hold = repo.holdWrites = Completer<void>();
      await confirm();
      await tester.pump();
      repo.failWith = 'network.unreachable';
      hold.complete();
      await tester.pumpAndSettle();
    }

    testWidgets('a link revoked, its read-back failing: shown revoked, and '
        'said so with a way to read again', (tester) async {
      await start(tester, '/communities/$owned/invitations');
      await tester.tap(find.byTooltip(CommunityCopy.revokeLink).first);
      await tester.pumpAndSettle();
      await readBackFails(
        tester,
        () => tester.tap(inDialog(find.text(CommunityCopy.revokeLink))),
      );
      expect(
        find.text(CommunityCopy.invitationState(InvitationState.revoked)),
        findsOneWidget,
      );
      expect(find.text(CommunityCopy.doneNotShown), findsOneWidget);
      repo.failWith = null;
      final reads = repo.invitationCursors.length;
      await tester.tap(
        find.descendant(
          of: find.byType(SnackBar),
          matching: find.text(CommunityCopy.refresh),
        ),
      );
      await tester.pumpAndSettle();
      expect(repo.invitationCursors.length, greaterThan(reads));
    });

    testWidgets('a member removed, its read-back failing: off the roster, and '
        'said so', (tester) async {
      await start(tester, '/communities/$owned/members');
      await tester.tap(options(studentName));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.removeMember));
      await tester.pumpAndSettle();
      await readBackFails(
        tester,
        () => tester.tap(find.text(CommunityCopy.confirmRemove)),
      );
      expect(find.text(studentName), findsNothing);
      expect(find.text(CommunityCopy.doneNotShown), findsOneWidget);
    });

    testWidgets('a lock, its read-back failing: shown locked, and said so', (
      tester,
    ) async {
      await start(tester, '/communities/$owned');
      await tester.tap(find.text(CommunityCopy.lock));
      await tester.pumpAndSettle();
      await readBackFails(
        tester,
        () => tester.tap(find.text(CommunityCopy.confirmLock)),
      );
      expect(find.text(CommunityCopy.lockedNotice), findsOneWidget);
      expect(find.text(CommunityCopy.unlock), findsOneWidget);
      expect(find.text(CommunityCopy.doneNotShown), findsOneWidget);
    });

    testWidgets('a grant, its read-back failing: shown granted, and said so '
        'in the sheet', (tester) async {
      await start(tester, '/communities/$owned/members');
      await tester.tap(options('الأستاذة عائشة'));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.memberCapabilities));
      await tester.pumpAndSettle();
      await tester.tap(
        find.text(CommunityCopy.capability(CommunityCapability.lock)),
      );
      await tester.pump();
      await readBackFails(
        tester,
        () => tester.tap(find.text(CommunityCopy.grantChosen)),
      );
      expect(find.text(CommunityCopy.granted), findsNWidgets(2));
      expect(find.text(CommunityCopy.doneNotShown), findsOneWidget);
    });

    testWidgets('a link revoked while the list refreshes is sent', (
      tester,
    ) async {
      await start(tester, '/communities/$owned/invitations');
      final refreshing = repo.holdInvitations = Completer<void>();
      await tester.tap(find.byTooltip(CommunityCopy.refresh));
      await tester.pump();
      await tester.tap(find.byTooltip(CommunityCopy.revokeLink).first);
      await tester.pumpAndSettle(const Duration(milliseconds: 50));
      await tester.tap(inDialog(find.text(CommunityCopy.revokeLink)));
      await frames(tester);
      expect(repo.writes.single, startsWith('revokeInvitation $owned '));
      repo.holdInvitations = null;
      refreshing.complete();
      await tester.pumpAndSettle();
      expect(
        find.text(CommunityCopy.invitationState(InvitationState.revoked)),
        findsOneWidget,
      );
    });

    testWidgets('a member removed while the roster refreshes is sent', (
      tester,
    ) async {
      await start(tester, '/communities/$owned/members');
      final refreshing = repo.holdMembers = Completer<void>();
      await tester.tap(find.byTooltip(CommunityCopy.refresh));
      await tester.pump();
      await removeStudent(tester);
      expect(repo.writes, ['removeMember $owned $student']);
      repo.holdMembers = null;
      refreshing.complete();
      await tester.pumpAndSettle();
      expect(find.text(studentName), findsNothing);
    });

    testWidgets('a leave confirmed while the community refreshes is sent', (
      tester,
    ) async {
      final app = await start(tester, '/communities/$open');
      final refreshing = repo.holdCommunity = Completer<void>();
      await tester.tap(find.byTooltip(CommunityCopy.refresh));
      await tester.pump();
      await tester.tap(find.text(CommunityCopy.leave));
      await tester.pumpAndSettle(const Duration(milliseconds: 50));
      await tester.tap(inDialog(find.text(CommunityCopy.confirmLeave)));
      await frames(tester);
      expect(repo.writes, ['leave $open']);
      repo.holdCommunity = null;
      refreshing.complete();
      await tester.pumpAndSettle();
      expect(locationIn(app), '/communities');
    });
  });
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/features/communities/state/pending_invitation.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'community_test_support.dart';

/// A change's answer moves the viewer only while they are still where they
/// asked for it: a hand-over goes back to the community, a leave to the
/// list, a join to the community joined — never from wherever the viewer
/// has gone meanwhile, and never away from a newer invitation.
void main() {
  const owned = MockCommunityRepository.ownedId;
  const open = MockCommunityRepository.openId;
  const invited = MockCommunityRepository.invitedId;
  const ownedTitle = 'مجتمع أسرة الحفظ';
  const openTitle = 'مجتمع طلاب التجويد';
  const teacherName = 'الأستاذة عائشة';
  const studentName = 'فاطمة الأنصاري';
  const teacherId = '${MockCommunityRepository.founder}-2';
  const signedIn = CurrentUser(
    id: viewer,
    displayName: 'طالب تجريبي',
    status: AccountStatus.active,
    roles: [],
    permissions: {},
  );

  late ScriptedCommunities repo;
  late ProviderContainer container;

  Future<void> start(
    WidgetTester tester,
    String path, {
    String? atStartup,
  }) async {
    repo = ScriptedCommunities();
    container = await openApp(
      tester,
      path,
      size: const Size(390, 2000),
      overrides: [
        communityRepositoryProvider.overrideWithValue(repo),
        messagingRepositoryProvider.overrideWithValue(ScriptedMessaging()),
        sessionUserProvider.overrideWith((ref) async => signedIn),
        if (atStartup != null)
          startupInvitationTokenProvider.overrideWithValue(atStartup),
      ],
    );
  }

  String location() => locationIn(container);

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

  /// Long enough for a page transition, without waiting on what is held.
  Future<void> frames(WidgetTester tester) async {
    for (var i = 0; i < 12; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  Future<void> back(WidgetTester tester) async {
    await tester.tap(find.byType(BackButton).last);
    await frames(tester);
  }

  /// From the community screen: the roster, then a hand-over to the
  /// teacher, confirmed and held.
  Future<Completer<void>> heldHandOver(WidgetTester tester) async {
    await tester.tap(find.text(CommunityCopy.viewMembers));
    await tester.pumpAndSettle();
    final hold = repo.holdWrites = Completer<void>();
    await tester.tap(options(teacherName));
    await tester.pumpAndSettle();
    await tester.tap(find.text(CommunityCopy.makeOwner));
    await tester.pumpAndSettle();
    await tester.tap(find.text(CommunityCopy.confirmTransfer));
    await frames(tester);
    expect(repo.writes, ['transferOwnership $owned $teacherId']);
    return hold;
  }

  group('a hand-over answered', () {
    testWidgets('on the roster: back to the community', (tester) async {
      await start(tester, '/communities/$owned');
      final hold = await heldHandOver(tester);
      hold.complete();
      await tester.pumpAndSettle();
      expect(location(), '/communities/$owned');
    });

    testWidgets('after the viewer went back to the community: stays', (
      tester,
    ) async {
      await start(tester, '/communities');
      await tester.tap(find.text(ownedTitle));
      await tester.pumpAndSettle();
      final hold = await heldHandOver(tester);
      await back(tester);
      expect(location(), '/communities/$owned');
      hold.complete();
      await tester.pumpAndSettle();
      expect(location(), '/communities/$owned');
    });

    testWidgets('after the viewer opened the chat: stays in it', (
      tester,
    ) async {
      await start(tester, '/communities/$owned');
      final hold = await heldHandOver(tester);
      await back(tester);
      await tester.tap(find.text(CommunityCopy.openChat));
      await frames(tester);
      expect(location(), '/messages/${chatOf(owned)}');
      hold.complete();
      await tester.pumpAndSettle();
      expect(location(), '/messages/${chatOf(owned)}');
    });

    testWidgets('with another row’s actions open: left open', (tester) async {
      await start(tester, '/communities/$owned');
      final hold = await heldHandOver(tester);
      await tester.tap(options(studentName));
      await frames(tester);
      expect(find.text(CommunityCopy.removeMember), findsOneWidget);
      hold.complete();
      await tester.pumpAndSettle();
      expect(location(), '/communities/$owned/members');
      expect(find.text(CommunityCopy.removeMember), findsOneWidget);
    });

    testWidgets('after the viewer went back to another tab: stays there', (
      tester,
    ) async {
      await start(tester, '/profile');
      final router = container.read(routerProvider);
      unawaited(router.push('/communities'));
      await tester.pumpAndSettle();
      unawaited(router.push('/communities/$owned'));
      await tester.pumpAndSettle();
      final hold = await heldHandOver(tester);
      await back(tester);
      await back(tester);
      await back(tester);
      expect(location(), '/profile');
      hold.complete();
      await tester.pumpAndSettle();
      expect(location(), '/profile');
    });
  });

  group('a leave answered', () {
    testWidgets('after the viewer went on to another community: stays '
        'there', (tester) async {
      await start(tester, '/communities');
      await tester.tap(find.text(openTitle));
      await tester.pumpAndSettle();
      final hold = repo.holdWrites = Completer<void>();
      await tester.tap(find.text(CommunityCopy.leave));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.confirmLeave));
      await frames(tester);
      expect(repo.writes, ['leave $open']);
      await back(tester);
      await tester.tap(find.text(ownedTitle));
      await frames(tester);
      expect(location(), '/communities/$owned');
      hold.complete();
      await tester.pumpAndSettle();
      expect(location(), '/communities/$owned');
    });
  });

  group('a join answered', () {
    testWidgets('after another link was opened: that invitation stays on '
        'screen', (tester) async {
      await start(
        tester,
        '/invite',
        atStartup: MockCommunityRepository.demoActiveToken,
      );
      final second = (await tester.runAsync(
        () => repo.createInvitation(owned),
      ))!.token;
      repo.writes.clear();
      final hold = repo.holdWrites = Completer<void>();
      await tester.tap(find.text(CommunityCopy.join));
      await tester.pump();
      expect(repo.writes, ['join']);
      container.read(pendingInvitationProvider.notifier).offer(second);
      await frames(tester);
      expect(find.text(CommunityCopy.join), findsOneWidget);
      hold.complete();
      await tester.pumpAndSettle();
      expect(location(), '/invite');
      expect(location(), isNot('/communities/$invited'));
      expect(container.read(pendingInvitationProvider)?.token, second);
      expect(find.text(CommunityCopy.join), findsOneWidget);
    });
  });
}

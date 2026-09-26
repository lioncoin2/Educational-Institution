import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override, ProviderBase;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/features/communities/state/community_controller.dart';
import 'package:quran_institution_app/features/communities/state/community_invitations_controller.dart';
import 'package:quran_institution_app/features/communities/state/community_members_controller.dart';
import 'package:quran_institution_app/features/communities/state/member_grants_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';
import 'community_test_support.dart';

/// What the links and roster screens offer comes from the community's own
/// `me`. When that read fails they say so — never an owner's page that
/// looks like no rights at all — and every way back reads `me` again: the
/// screen's retry and refresh, a sign-in (from any prompt), a reconnect.
void main() {
  const owned = MockCommunityRepository.ownedId;
  const studentName = 'فاطمة الأنصاري';
  const signedIn = CurrentUser(
    id: viewer,
    displayName: 'طالب تجريبي',
    status: AccountStatus.active,
    roles: [],
    permissions: {},
  );

  Uri webLink(String token) =>
      Uri.parse('https://example.org/app/invite').replace(fragment: token);

  late ProviderContainer container;

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

  group('the community’s me could not be read', () {
    late _CommunityReadFails repo;
    late FakeRealtimeClient realtime;

    setUp(() {
      repo = _CommunityReadFails();
      realtime = FakeRealtimeClient();
    });

    Future<void> start(
      WidgetTester tester,
      String path, {
      List<Override> extra = const [],
    }) async {
      container = await openApp(
        tester,
        path,
        size: const Size(390, 2000),
        overrides: [
          communityRepositoryProvider.overrideWithValue(repo),
          messagingRepositoryProvider.overrideWithValue(ScriptedMessaging()),
          sessionUserProvider.overrideWith((ref) async => signedIn),
          inviteLinkBuilderProvider.overrideWithValue(webLink),
          realtimeConnectionProvider.overrideWithValue(realtime),
          ...extra,
        ],
      );
    }

    testWidgets('the links say so, and its retry brings back what the '
        'server allows', (tester) async {
      repo.failures = 1;
      await start(tester, '/communities/$owned/invitations');
      expect(find.text(CommunityCopy.createdByYou), findsNWidgets(2));
      expect(
        find.text(CommunityCopy.error('network.unreachable')),
        findsOneWidget,
      );
      expect(find.text(CommunityCopy.createLink), findsNothing);
      final reads = repo.communityRequests.length;
      await tester.tap(find.text(CommunityCopy.retry));
      await tester.pumpAndSettle();
      expect(repo.communityRequests.length, reads + 1);
      expect(
        find.text(CommunityCopy.error('network.unreachable')),
        findsNothing,
      );
      expect(find.text(CommunityCopy.createLink), findsOneWidget);
      expect(find.byTooltip(CommunityCopy.revokeLink), findsNWidgets(2));
    });

    testWidgets('the links’ refresh reads the community again too', (
      tester,
    ) async {
      repo.failures = 1;
      await start(tester, '/communities/$owned/invitations');
      final reads = repo.communityRequests.length;
      await tester.tap(find.byTooltip(CommunityCopy.refresh));
      await tester.pumpAndSettle();
      expect(repo.communityRequests.length, reads + 1);
      expect(find.text(CommunityCopy.createLink), findsOneWidget);
    });

    testWidgets('the roster says so, and its retry brings back the rows’ '
        'actions', (tester) async {
      repo.failures = 1;
      await start(tester, '/communities/$owned/members');
      expect(find.text(studentName), findsOneWidget);
      expect(options(studentName), findsNothing);
      expect(
        find.text(CommunityCopy.error('network.unreachable')),
        findsOneWidget,
      );
      await tester.tap(find.text(CommunityCopy.retry));
      await tester.pumpAndSettle();
      expect(options(studentName), findsOneWidget);
    });

    testWidgets('the roster’s refresh reads the community again too', (
      tester,
    ) async {
      repo.failures = 1;
      await start(tester, '/communities/$owned/members');
      final reads = repo.communityRequests.length;
      await tester.tap(find.byTooltip(CommunityCopy.refresh));
      await tester.pumpAndSettle();
      expect(repo.communityRequests.length, reads + 1);
      expect(options(studentName), findsOneWidget);
    });

    testWidgets('both failed: the list’s retry reads the community again '
        'too', (tester) async {
      await start(tester, '/home');
      repo.failWith = 'network.unreachable';
      container.read(routerProvider).go('/communities/$owned/invitations');
      await tester.pumpAndSettle();
      expect(
        find.text(CommunityCopy.error('network.unreachable')),
        findsOneWidget,
      );
      repo.failWith = null;
      await tester.tap(find.text(CommunityCopy.retry));
      await tester.pumpAndSettle();
      expect(find.text(CommunityCopy.createdByYou), findsNWidgets(2));
      expect(find.text(CommunityCopy.createLink), findsOneWidget);
      expect(find.byTooltip(CommunityCopy.revokeLink), findsNWidgets(2));
    });

    test('a reconnect reads a community whose first read failed', () async {
      repo.failures = 1;
      final realtime = FakeRealtimeClient();
      final container = ProviderContainer(
        overrides: [
          communityRepositoryProvider.overrideWithValue(repo),
          messagingRepositoryProvider.overrideWithValue(ScriptedMessaging()),
          realtimeConnectionProvider.overrideWithValue(realtime),
        ],
      );
      addTearDown(container.dispose);
      final screen = container.listen(communityProvider(owned), (_, _) {});
      addTearDown(screen.close);
      await expectLater(
        container.read(communityProvider(owned).future),
        throwsA(isA<CommunityException>()),
      );
      expect(container.read(communityProvider(owned)).hasValue, isFalse);
      realtime.setStatus(RealtimeStatus.reconnected);
      await pumpEventQueue();
      final healed = container.read(communityProvider(owned));
      expect(healed.hasValue, isTrue);
      expect(
        healed.requireValue.community!.me.allows(
          CommunityOperation.invitationsManage,
        ),
        isTrue,
      );
    });
  });

  group('a sign-in', () {
    testWidgets('from the prompt of a screen that could not read: that '
        'screen reads again when the sign-in closes', (tester) async {
      final repo = ScriptedCommunities()
        ..failWith = 'identity.authentication_required';
      container = await openApp(
        tester,
        '/communities/$owned/invitations',
        size: const Size(390, 2000),
        overrides: [
          communityRepositoryProvider.overrideWithValue(repo),
          messagingRepositoryProvider.overrideWithValue(ScriptedMessaging()),
          inviteLinkBuilderProvider.overrideWithValue(webLink),
        ],
      );
      expect(find.text(CommunityCopy.signInTitle), findsOneWidget);
      final reads = repo.invitationCursors.length;
      // Not even signed in: closing the sign-in still tries again.
      await tester.tap(find.text('تسجيل الدخول'));
      await tester.pumpAndSettle();
      repo.failWith = null;
      container.read(routerProvider).pop();
      await tester.pumpAndSettle();
      expect(repo.invitationCursors.length, greaterThan(reads));
      expect(find.text(CommunityCopy.signInTitle), findsNothing);
      expect(find.text(CommunityCopy.createLink), findsOneWidget);
    });

    test('reads every community view again when the account changes', () async {
      const key = (
        communityId: owned,
        userId: '${MockCommunityRepository.founder}-2',
      );
      // Each view on its own, so that what is counted is its own reading:
      // the grants read the community's `me` beside them too.
      final views =
          <(String, ProviderBase<Object?>, int Function(ScriptedCommunities))>[
            (
              'the community',
              communityProvider(owned),
              (repo) => repo.communityRequests.length,
            ),
            (
              'the roster',
              communityMembersProvider(owned),
              (repo) => repo.memberCursors.length,
            ),
            (
              'the links',
              communityInvitationsProvider(owned),
              (repo) => repo.invitationCursors.length,
            ),
            (
              'the grants',
              memberGrantsProvider(key),
              (repo) => repo.grantRequests.length,
            ),
          ];
      for (final (what, view, reads) in views) {
        final repo = ScriptedCommunities();
        CurrentUser? session;
        final container = ProviderContainer(
          overrides: [
            communityRepositoryProvider.overrideWithValue(repo),
            messagingRepositoryProvider.overrideWithValue(ScriptedMessaging()),
            realtimeConnectionProvider.overrideWithValue(FakeRealtimeClient()),
            sessionUserProvider.overrideWith((ref) async => session),
          ],
        );
        addTearDown(container.dispose);
        await container.read(sessionUserProvider.future);
        final screen = container.listen(view, (_, _) {});
        addTearDown(screen.close);
        await pumpEventQueue();
        final before = reads(repo);
        session = signedIn; // signed in: the session's account changes
        container.invalidate(sessionUserProvider);
        await container.read(sessionUserProvider.future);
        await pumpEventQueue();
        expect(reads(repo), greaterThan(before), reason: what);
      }
    });

    testWidgets('against the backend: opened by address signed out, signed '
        'in from its prompt — the owner is offered the links', (tester) async {
      final server = CommunityServer({
        'POST /auth/login': (_) => jsonResponse(200, {
          'accessToken': 'a1',
          'refreshToken': 'r1',
          'user': signedInUser,
        }),
        'GET /auth/me': (_) => jsonResponse(200, signedInUser),
        'GET /communities': (_) => jsonResponse(200, {
          'items': [communityJson(id: 'c-1', title: 'مجتمع المالك')],
          'nextCursor': null,
        }),
        'GET /communities/c-1': (_) => jsonResponse(
          200,
          communityJson(
            id: 'c-1',
            title: 'مجتمع المالك',
            standing: 'OWNER',
            capabilities: const [
              'community.members.view',
              'community.members.invite',
              'community.lock',
            ],
            operations: const [
              'community.invitations.manage',
              'community.grants.manage',
              'community.ownership.transfer',
            ],
          ),
        ),
        'GET /communities/c-1/invitations': (_) => jsonResponse(200, {
          'items': [invitationJson('i-1', createdBy: 'user-2', uses: 1)],
          'nextCursor': null,
        }),
      });
      container = await openApp(
        tester,
        '/communities/c-1/invitations',
        size: const Size(390, 2000),
        overrides: [
          ...backendOverrides(
            server,
            signedIn: false,
            tokens: InMemoryTokenStore(),
          ),
          inviteLinkBuilderProvider.overrideWithValue(webLink),
        ],
      );
      int reads(String path) =>
          server.calls.where((c) => c == 'GET $path').length;
      expect(find.text(CommunityCopy.signInTitle), findsOneWidget);
      await tester.tap(find.text('تسجيل الدخول'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).at(0), 'owner@example.org');
      await tester.enterText(find.byType(TextField).at(1), 'secret');
      await tester.tap(find.text('دخول'));
      await tester.pumpAndSettle();
      expect(locationIn(container), '/communities/c-1/invitations');
      expect(find.text(CommunityCopy.signInTitle), findsNothing);
      expect(reads('/communities/c-1/invitations'), greaterThanOrEqualTo(1));
      expect(reads('/communities/c-1'), greaterThanOrEqualTo(1));
      expect(find.text(CommunityCopy.createLink), findsOneWidget);
      expect(find.byTooltip(CommunityCopy.revokeLink), findsOneWidget);

      container.read(routerProvider).pop();
      await tester.pumpAndSettle();
      expect(locationIn(container), '/communities/c-1');
      expect(find.text(CommunityCopy.signInTitle), findsNothing);
      expect(find.text('مجتمع المالك'), findsWidgets);
    });
  });
}

/// The scripted server, whose next [failures] reads of a community are
/// unanswered.
class _CommunityReadFails extends ScriptedCommunities {
  int failures = 0;

  @override
  Future<Community> community(String communityId) async {
    if (failures > 0) {
      failures -= 1;
      communityRequests.add(communityId);
      throw const CommunityException('network.unreachable', 'unreachable');
    }
    return super.community(communityId);
  }
}

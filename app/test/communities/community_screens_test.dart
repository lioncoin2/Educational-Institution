import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/core/widgets/foundations/mock_ribbon.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_notifications_repository.dart';
import 'package:quran_institution_app/features/communities/communities_screen.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/features/communities/community_members_screen.dart';
import 'package:quran_institution_app/features/communities/community_screen.dart';
import 'package:quran_institution_app/features/messaging/messaging_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';
import 'community_test_support.dart';

/// The community screens in the real app: what they show for each state the
/// server can be in, every action shown if and only if the server's answer
/// holds it, and the way to a community's chat.
void main() {
  const open = MockCommunityRepository.openId;
  const owned = MockCommunityRepository.ownedId;
  const lockedOne = MockCommunityRepository.lockedId;
  const large = MockCommunityRepository.largeId;

  late ScriptedCommunities repo;
  late ScriptedMessaging messaging;
  late ProviderContainer container;

  String location() => container
      .read(routerProvider)
      .routerDelegate
      .currentConfiguration
      .last
      .matchedLocation;

  Future<void> open_(
    WidgetTester tester,
    String path, {
    List<Override> extra = const [],
    Size size = const Size(390, 844),
    bool demo = true,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    container = ProviderContainer(
      overrides: [
        if (demo) ...[
          communityRepositoryProvider.overrideWithValue(repo),
          messagingRepositoryProvider.overrideWithValue(messaging),
        ],
        ...extra,
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const QuranInstitutionApp(),
      ),
    );
    await tester.pump(const Duration(seconds: 3)); // the splash timer
    await tester.pumpAndSettle();
    container.read(routerProvider).go(path);
    await tester.pumpAndSettle();
  }

  setUp(() {
    repo = ScriptedCommunities();
    messaging = ScriptedMessaging();
  });

  group('مجتمعاتي', () {
    testWidgets(
      'lists the communities with their figures, flagged as demo data',
      (tester) async {
        await open_(tester, '/communities');
        expect(find.text('مجتمع طلاب التجويد'), findsOneWidget);
        expect(find.text('مجتمع أسرة الحفظ'), findsOneWidget);
        expect(find.text('24 عضوًا'), findsOneWidget);
        expect(find.text('مالك المجتمع'), findsOneWidget);
        expect(find.textContaining('مجتمعات تجريبية'), findsOneWidget);
        // The locked one says so on its row.
        await tester.scrollUntilVisible(
          find.text('مجتمع المراجعة الأسبوعية'),
          200,
        );
        expect(find.text(CommunityCopy.locked), findsOneWidget);
      },
    );

    testWidgets('says so when the viewer is in no community', (tester) async {
      repo.leaveAll();
      await open_(tester, '/communities');
      expect(find.text(CommunityCopy.empty), findsOneWidget);
      expect(find.byType(MockBanner), findsNothing);
    });

    testWidgets('explains a failure and recovers on retry', (tester) async {
      repo.failWith = 'network.unreachable';
      await open_(tester, '/communities');
      expect(
        find.text(CommunityCopy.error('network.unreachable')),
        findsOneWidget,
      );

      repo.failWith = null;
      await tester.tap(find.text(CommunityCopy.retry));
      await tester.pumpAndSettle();
      expect(find.text('مجتمع طلاب التجويد'), findsOneWidget);
    });

    testWidgets('loads the next page on request', (tester) async {
      repo = ScriptedCommunities(communityPageSize: 2);
      await open_(tester, '/communities');
      expect(find.text('مجتمع حلقة المساء'), findsNothing);
      await tester.tap(find.text(CommunityCopy.loadMore));
      await tester.pumpAndSettle();
      expect(find.text('مجتمع حلقة المساء'), findsOneWidget);
    });

    testWidgets('opens a community from its row', (tester) async {
      await open_(tester, '/communities');
      await tester.tap(find.text('مجتمع طلاب التجويد'));
      await tester.pumpAndSettle();
      expect(location(), '/communities/$open');
      expect(find.text(CommunityCopy.openChat), findsOneWidget);
    });
  });

  group('one community', () {
    testWidgets('shows the owner every capability, the chat and the roster', (
      tester,
    ) async {
      await open_(tester, '/communities/$owned', size: const Size(390, 1400));
      expect(find.text('مجتمع أسرة الحفظ'), findsWidgets);
      expect(find.text('12 عضوًا'), findsOneWidget);
      expect(find.text('مالك المجتمع'), findsOneWidget);
      for (final capability in CommunityCapability.values) {
        if (capability == CommunityCapability.unknown) continue;
        expect(find.text(CommunityCopy.capability(capability)), findsOneWidget);
      }
      expect(find.text(CommunityCopy.openChat), findsOneWidget);
      expect(find.text(CommunityCopy.viewMembers), findsOneWidget);
      expect(find.text(CommunityCopy.lockedNotice), findsNothing);
      expect(find.textContaining('مجتمع تجريبي'), findsOneWidget);
    });

    testWidgets(
      'offers a plain member the chat, and nothing it was not given',
      (tester) async {
        await open_(tester, '/communities/$open', size: const Size(390, 1400));
        expect(find.text('عضو'), findsOneWidget);
        expect(find.text(CommunityCopy.openChat), findsOneWidget);
        expect(find.text(CommunityCopy.viewMembers), findsNothing);
        expect(find.text(CommunityCopy.capabilitiesTitle), findsNothing);
      },
    );

    testWidgets('names a member’s capability as it names any other', (
      tester,
    ) async {
      await open_(
        tester,
        '/communities/${MockCommunityRepository.delegatedId}',
        size: const Size(390, 1400),
      );
      expect(
        find.text(CommunityCopy.capability(CommunityCapability.membersView)),
        findsOneWidget,
      );
      expect(find.text(CommunityCopy.viewMembers), findsOneWidget);
    });

    testWidgets(
      'never says how a capability is held — the answer does not say',
      (tester) async {
        // What the server answers a former owner (an admin) after handing
        // the community over: a MEMBER holding, by oversight, what no owner
        // delegated. The answer carries no basis.
        repo = _AnsweredAs(
          communityJson(
            id: 'c-1',
            capabilities: const [
              'community.members.view',
              'community.members.remove',
              'community.lock',
            ],
          ),
        );
        await open_(tester, '/communities/c-1', size: const Size(390, 1400));
        expect(find.text('عضو'), findsOneWidget);
        for (final c in [
          CommunityCapability.membersView,
          CommunityCapability.membersRemove,
          CommunityCapability.lock,
        ]) {
          expect(find.text(CommunityCopy.capability(c)), findsOneWidget);
        }
        expect(find.textContaining('مفوَّض'), findsNothing); // "delegated"
      },
    );

    testWidgets('says a locked community is locked — and no more than that', (
      tester,
    ) async {
      await open_(
        tester,
        '/communities/$lockedOne',
        size: const Size(390, 1400),
      );
      expect(find.text(CommunityCopy.lockedNotice), findsOneWidget);
      expect(find.text(CommunityCopy.locked), findsOneWidget);
      // Reading its chat stays open: the server still lists chat.read.
      expect(find.text(CommunityCopy.openChat), findsOneWidget);
    });

    testWidgets('shows only what the server offers after a lock', (
      tester,
    ) async {
      final realtime = FakeRealtimeClient();
      await open_(
        tester,
        '/communities/$owned',
        size: const Size(390, 1400),
        extra: [realtimeConnectionProvider.overrideWithValue(realtime)],
      );
      expect(
        find.text(CommunityCopy.capability(CommunityCapability.chatPost)),
        findsOneWidget,
      );
      final version = repo.changeStatus(owned, CommunityStatus.locked);
      realtime.emit(locked(owned, version));
      await tester.pumpAndSettle();
      expect(find.text(CommunityCopy.lockedNotice), findsOneWidget);
      expect(
        find.text(CommunityCopy.capability(CommunityCapability.chatPost)),
        findsNothing,
      );
    });

    testWidgets('says the viewer is no longer a member, with a way back', (
      tester,
    ) async {
      final realtime = FakeRealtimeClient();
      await open_(
        tester,
        '/communities/$open',
        extra: [realtimeConnectionProvider.overrideWithValue(realtime)],
      );
      repo.endMembership(open);
      realtime.emit(removed(open));
      await tester.pumpAndSettle();
      expect(find.text(CommunityCopy.removed), findsOneWidget);
      expect(find.text(CommunityCopy.openChat), findsNothing);

      await tester.tap(find.text(CommunityCopy.backToList));
      await tester.pumpAndSettle();
      expect(location(), '/communities');
      expect(find.text('مجتمع طلاب التجويد'), findsNothing);
    });

    testWidgets('says a community it never saw is not available', (
      tester,
    ) async {
      await open_(tester, '/communities/mock-community-nowhere');
      expect(find.text(CommunityCopy.gone), findsOneWidget);
      expect(find.text(CommunityCopy.backToList), findsOneWidget);
    });

    testWidgets('explains a failure with a retry', (tester) async {
      repo.failWith = 'unavailable';
      await open_(tester, '/communities/$open');
      expect(find.text(CommunityCopy.error('unavailable')), findsOneWidget);
      repo.failWith = null;
      await tester.tap(find.text(CommunityCopy.retry));
      await tester.pumpAndSettle();
      expect(find.text(CommunityCopy.openChat), findsOneWidget);
    });

    testWidgets('opens the community’s chat at /messages/<its id>', (
      tester,
    ) async {
      await open_(tester, '/communities/$open', size: const Size(390, 1400));
      await tester.tap(find.text(CommunityCopy.openChat));
      await tester.pumpAndSettle();
      expect(location(), '/messages/${chatOf(open)}');
      expect(
        find.text('درس أحكام النون الساكنة يوم الأحد بإذن الله.'),
        findsOneWidget,
      );
      // A reader of a community chat gets the neutral notice, not the
      // announcement-channel one.
      expect(find.text(MessagingCopy.cannotPostHere), findsOneWidget);
      expect(find.textContaining('قناة إعلانات'), findsNothing);
      expect(find.byType(TextField), findsNothing);
    });

    testWidgets('lets the owner post in the community’s chat', (tester) async {
      await open_(tester, '/communities/$owned', size: const Size(390, 1400));
      await tester.tap(find.text(CommunityCopy.openChat));
      await tester.pumpAndSettle();
      expect(location(), '/messages/${chatOf(owned)}');
      expect(find.byType(TextField), findsOneWidget);
    });

    testWidgets('says why the chat cannot open, and stays', (tester) async {
      messaging.leftCommunities.add(open);
      await open_(tester, '/communities/$open', size: const Size(390, 1400));
      await tester.tap(find.text(CommunityCopy.openChat));
      await tester.pumpAndSettle();
      expect(location(), '/communities/$open');
      expect(
        find.text(
          CommunityCopy.chatUnavailable('messaging.conversation_not_found'),
        ),
        findsOneWidget,
      );
    });
  });

  group('the roster', () {
    testWidgets(
      'shows a page of members, names or a neutral word, and more on request',
      (tester) async {
        await open_(
          tester,
          '/communities/$large/members',
          size: const Size(390, 2400),
        );
        expect(find.text('الأستاذ عبدالله'), findsOneWidget);
        expect(find.text('طالب تجريبي'), findsOneWidget);
        expect(find.text(CommunityCopy.unnamedMember), findsWidgets);
        expect(find.text(CommunityCopy.inactiveAccount), findsWidgets);
        expect(find.textContaining('mock-community'), findsNothing); // no ids
        expect(find.textContaining('أعضاء تجريبيون'), findsOneWidget);
        expect(repo.memberCursors, hasLength(1));

        await tester.scrollUntilVisible(find.text(CommunityCopy.loadMore), 400);
        await tester.tap(find.text(CommunityCopy.loadMore));
        await tester.pumpAndSettle();
        expect(repo.memberCursors, hasLength(2));
        expect(repo.membersBuilt, 100);
      },
    );

    testWidgets('is reached from the community when the server allows it', (
      tester,
    ) async {
      await open_(tester, '/communities/$owned', size: const Size(390, 1400));
      await tester.tap(find.text(CommunityCopy.viewMembers));
      await tester.pumpAndSettle();
      expect(location(), '/communities/$owned/members');
      expect(find.text(CommunityCopy.membersTitle), findsOneWidget);
      expect(find.text('مجتمع أسرة الحفظ'), findsOneWidget); // the subtitle
    });

    testWidgets('says a community it never saw is not available', (
      tester,
    ) async {
      await open_(tester, '/communities/mock-community-nowhere/members');
      expect(find.text(CommunityCopy.gone), findsOneWidget);
      expect(find.text(CommunityCopy.removed), findsNothing);
      expect(find.text(CommunityCopy.backToList), findsOneWidget);
    });

    testWidgets('says the viewer is no longer a member once removed', (
      tester,
    ) async {
      final realtime = FakeRealtimeClient();
      await open_(
        tester,
        '/communities/$owned/members',
        extra: [realtimeConnectionProvider.overrideWithValue(realtime)],
      );
      expect(find.text('طالب تجريبي'), findsOneWidget);
      repo.endMembership(owned);
      realtime.emit(removed(owned));
      await tester.pumpAndSettle();
      expect(find.text(CommunityCopy.removed), findsOneWidget);
      expect(find.text(CommunityCopy.gone), findsNothing);
    });

    testWidgets('says "not yours to see" to a plain member', (tester) async {
      await open_(tester, '/communities/$open/members');
      expect(find.text(CommunityCopy.membersForbidden), findsOneWidget);
      expect(find.text(CommunityCopy.loadMore), findsNothing);
    });

    testWidgets('explains a failure with a retry', (tester) async {
      repo.failWith = 'network.unreachable';
      await open_(tester, '/communities/$large/members');
      expect(
        find.text(CommunityCopy.error('network.unreachable')),
        findsWidgets,
      );
      repo.failWith = null;
      await tester.tap(find.text(CommunityCopy.retry));
      await tester.pumpAndSettle();
      expect(find.text('الأستاذ عبدالله'), findsOneWidget);
    });
  });

  group('reads right to left', () {
    for (final (path, screen) in [
      ('/communities', CommunitiesScreen),
      ('/communities/$owned', CommunityScreen),
      ('/communities/$large/members', CommunityMembersScreen),
    ]) {
      testWidgets(path, (tester) async {
        await open_(tester, path);
        expect(
          Directionality.of(tester.element(find.byType(screen))),
          TextDirection.rtl,
        );
      });
    }
  });

  group('against the backend', () {
    late CommunityServer server;

    List<Override> backend({required bool signedIn}) {
      final tokens = InMemoryTokenStore();
      if (signedIn) {
        tokens.write(const Tokens(accessToken: 'a1', refreshToken: 'r1'));
      }
      return [
        backendModeProvider.overrideWithValue(true),
        httpClientProvider.overrideWithValue(server.client),
        tokenStoreProvider.overrideWithValue(tokens),
        apiClientProvider.overrideWith(
          (ref) => ApiClient(
            baseUri: Uri.parse('https://api.test/'),
            httpClient: server.client,
            tokenStore: tokens,
            onSignedOut: () => ref.invalidate(sessionUserProvider),
          ),
        ),
        realtimeClientProvider.overrideWithValue(
          const DisabledRealtimeClient(),
        ),
        notificationsRepositoryProvider.overrideWithValue(
          MockNotificationsRepository(latency: Duration.zero, seed: false),
        ),
      ];
    }

    setUp(() {
      server = CommunityServer({
        'GET /auth/me': (_) => jsonResponse(200, signedInUser),
        'GET /communities': (_) => jsonResponse(200, {
          'items': [communityJson(id: 'c-1', title: 'مجتمع من الخادم')],
          'nextCursor': null,
        }),
      });
    });

    testWidgets('asks a signed-out visitor to sign in, and fetches nothing', (
      tester,
    ) async {
      await open_(
        tester,
        '/communities',
        extra: backend(signedIn: false),
        demo: false,
      );
      expect(find.text(CommunityCopy.signInTitle), findsOneWidget);
      expect(server.calls.where((c) => c == 'GET /communities'), isEmpty);
    });

    testWidgets('asks for a sign-in on a community’s page too', (tester) async {
      await open_(
        tester,
        '/communities/c-1',
        extra: backend(signedIn: false),
        demo: false,
      );
      expect(find.text(CommunityCopy.signInTitle), findsOneWidget);
      expect(find.text(CommunityCopy.retry), findsNothing);
    });

    testWidgets('offers exactly what the server’s answer holds', (
      tester,
    ) async {
      server.routes['GET /communities/c-1'] = (_) => jsonResponse(
        200,
        communityJson(
          id: 'c-1',
          title: 'مجتمع من الخادم',
          participation: const ['community.view'],
        ),
      );
      await open_(
        tester,
        '/communities/c-1',
        extra: backend(signedIn: true),
        demo: false,
        size: const Size(390, 1400),
      );
      expect(find.text('مجتمع من الخادم'), findsWidgets);
      expect(find.text('عضو'), findsOneWidget);
      // No chat.read and no members.view in the answer: neither is offered.
      expect(find.text(CommunityCopy.openChat), findsNothing);
      expect(find.text(CommunityCopy.viewMembers), findsNothing);
      expect(find.byType(MockBanner), findsNothing);
    });

    testWidgets(
      'shows the server’s communities to a signed-in person, unmarked',
      (tester) async {
        // The repository is the app's own wiring: HTTP, in backend mode.
        await open_(
          tester,
          '/communities',
          extra: backend(signedIn: true),
          demo: false,
        );
        expect(find.text('مجتمع من الخادم'), findsOneWidget);
        expect(find.byType(MockBanner), findsNothing);
        expect(
          server.requests
              .where((r) => r.url.path == '/communities')
              .single
              .url
              .queryParameters,
          {'scope': 'mine'},
        );
      },
    );
  });
}

/// Answers every community read with [json], as the server sent it.
class _AnsweredAs extends ScriptedCommunities {
  _AnsweredAs(this.json);

  final Map<String, Object?> json;

  @override
  Future<Community> community(String communityId) async =>
      Community.fromJson(json);
}

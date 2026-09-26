import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/features/communities/invite_screen.dart';
import 'package:quran_institution_app/features/communities/state/community_write.dart';
import 'package:quran_institution_app/features/communities/state/invitation_join_controller.dart';
import 'package:quran_institution_app/features/communities/state/pending_invitation.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'community_test_support.dart';

/// Opening an invitation link, in the real app: the token the app was
/// handed — at startup, or while running — waits in memory across a
/// sign-in, is sent once, in the body of one request, when the viewer taps
/// Join, and is forgotten once used or refused for good.
void main() {
  const token = MockCommunityRepository.demoActiveToken;
  const invited = MockCommunityRepository.invitedId;
  const invitedTitle = 'مجتمع حلقة الفجر';

  late ScriptedCommunities repo;
  late ProviderContainer container;

  const signedIn = CurrentUser(
    id: viewer,
    displayName: 'طالب تجريبي',
    status: AccountStatus.active,
    roles: [],
    permissions: {},
  );

  /// The app opened at /invite — on a web page, it is where a link lands —
  /// with [atStartup] as the link it was opened with.
  Future<void> start(
    WidgetTester tester, {
    String? atStartup,
    bool signIn = true,
    List<Override> extra = const [],
  }) async {
    container = await openApp(
      tester,
      '/invite',
      overrides: [
        communityRepositoryProvider.overrideWithValue(repo),
        messagingRepositoryProvider.overrideWithValue(ScriptedMessaging()),
        startupInvitationTokenProvider.overrideWithValue(atStartup),
        if (signIn) sessionUserProvider.overrideWith((ref) async => signedIn),
        ...extra,
      ],
    );
  }

  PendingInvitation? held() => container.read(pendingInvitationProvider);

  Future<void> tapJoin(WidgetTester tester) async {
    await tester.tap(find.text(CommunityCopy.join));
    await tester.pumpAndSettle();
  }

  setUp(() => repo = ScriptedCommunities());

  testWidgets('cold start, signed out: sign in, join with one tap — and the '
      'community opens, the link forgotten', (tester) async {
    await start(tester, atStartup: token, signIn: false);
    expect(find.text(CommunityCopy.signInToJoin), findsOneWidget);
    expect(find.text(CommunityCopy.join), findsNothing);

    await tester.tap(find.text('تسجيل الدخول'));
    await tester.pumpAndSettle();
    expect(locationIn(container), '/sign-in');
    await tester.enterText(find.byType(TextField).at(0), 'student@example.org');
    await tester.enterText(find.byType(TextField).at(1), 'secret');
    await tester.tap(find.text('دخول'));
    await tester.pumpAndSettle();

    // Back, the link still in memory — and nothing joined by opening it.
    expect(locationIn(container), '/invite');
    expect(find.text(CommunityCopy.invited), findsOneWidget);
    expect(held()?.token, token);
    expect(repo.writes, isEmpty);

    await tapJoin(tester);
    expect(repo.writes, ['join']);
    expect(locationIn(container), '/communities/$invited');
    expect(find.text(invitedTitle), findsWidgets);
    expect(find.text(CommunityCopy.inTheCommunity), findsOneWidget);
    expect(held(), isNull);

    // Back on /invite: nothing to open, nothing sent.
    container.read(routerProvider).go('/invite');
    await tester.pumpAndSettle();
    expect(find.text(CommunityCopy.noInvitation), findsOneWidget);
    expect(repo.writes, ['join']);
  });

  testWidgets('already signed in: the invitation, and its button', (
    tester,
  ) async {
    await start(tester, atStartup: token);
    expect(find.text(CommunityCopy.invited), findsOneWidget);
    expect(find.text(CommunityCopy.join), findsOneWidget);
    expect(find.text(CommunityCopy.signInToJoin), findsNothing);
    // Nothing else is known before joining: no title, no id, no token.
    expect(find.textContaining(invitedTitle), findsNothing);
    expect(find.textContaining('mock-'), findsNothing);
    expect(find.textContaining(token), findsNothing);
  });

  testWidgets('warm start: a link opened while the screen is up starts it '
      'over with that link', (tester) async {
    await start(tester);
    expect(find.text(CommunityCopy.noInvitation), findsOneWidget);

    container
        .read(pendingInvitationProvider.notifier)
        .offer(MockCommunityRepository.demoExpiredToken);
    await tester.pumpAndSettle();
    await tapJoin(tester);
    expect(
      find.text(CommunityCopy.joinFailed('communities.invitation_expired')),
      findsOneWidget,
    );

    container.read(pendingInvitationProvider.notifier).offer(token);
    await tester.pumpAndSettle();
    expect(find.text(CommunityCopy.invited), findsOneWidget);
    await tapJoin(tester);
    expect(locationIn(container), '/communities/$invited');
    expect(repo.writes, ['join', 'join']);
  });

  testWidgets('something with no token’s shape: refused at once, nothing '
      'sent, forgotten', (tester) async {
    await start(tester, atStartup: 'not-a-token');
    expect(find.text(CommunityCopy.joinFailed(null)), findsOneWidget);
    expect(find.text(CommunityCopy.join), findsNothing);
    expect(repo.writes, isEmpty);
    expect(held(), isNull);
    await tester.tap(find.text(CommunityCopy.toCommunities));
    await tester.pumpAndSettle();
    expect(locationIn(container), '/communities');
  });

  for (final (what, link, code) in [
    (
      'an expired',
      MockCommunityRepository.demoExpiredToken,
      'communities.invitation_expired',
    ),
    (
      'a revoked',
      MockCommunityRepository.demoRevokedToken,
      'communities.invitation_revoked',
    ),
    (
      'a used-up',
      MockCommunityRepository.demoExhaustedToken,
      'communities.invitation_exhausted',
    ),
    ('an unknown', 'Z' * 43, 'communities.invitation_invalid'),
  ]) {
    testWidgets('$what link: said, forgotten, and the way to the viewer’s '
        'communities', (tester) async {
      await start(tester, atStartup: link);
      await tapJoin(tester);
      expect(find.text(CommunityCopy.joinFailed(code)), findsOneWidget);
      expect(find.text(CommunityCopy.join), findsNothing);
      expect(find.text(CommunityCopy.retry), findsNothing);
      expect(held(), isNull);
      expect(repo.writes, ['join']);
      await tester.tap(find.text(CommunityCopy.toCommunities));
      await tester.pumpAndSettle();
      expect(locationIn(container), '/communities');
    });
  }

  testWidgets('no connection: said, the link kept — and sent again only on '
      'request', (tester) async {
    await start(tester, atStartup: token);
    repo.failWritesWith = 'network.unreachable';
    await tapJoin(tester);
    expect(
      find.text(CommunityCopy.joinFailed('network.unreachable')),
      findsOneWidget,
    );
    expect(held()?.token, token);
    await tester.pump(const Duration(seconds: 5));
    expect(repo.writes, ['join']); // nothing sent on its own

    repo.failWritesWith = null;
    await tester.tap(find.text(CommunityCopy.retry));
    await tester.pumpAndSettle();
    expect(repo.writes, ['join', 'join']);
    expect(locationIn(container), '/communities/$invited');
    expect(held(), isNull);
  });

  testWidgets('a double tap sends one request', (tester) async {
    await start(tester, atStartup: token);
    final hold = repo.holdWrites = Completer<void>();
    await tester.tap(find.text(CommunityCopy.join));
    await tester.pump();
    // The button spins, and takes no tap; the controller sends nothing
    // either.
    expect(find.text(CommunityCopy.join), findsNothing);
    await tester.tap(find.byType(FilledButton), warnIfMissed: false);
    expect(
      await container.read(invitationJoinProvider.notifier).join(),
      isA<WriteNotSent<Object?>>(),
    );
    hold.complete();
    await tester.pumpAndSettle();
    expect(repo.writes, ['join']);
    expect(locationIn(container), '/communities/$invited');
  });

  testWidgets('reads right to left', (tester) async {
    await start(tester, atStartup: token);
    expect(
      Directionality.of(tester.element(find.byType(InviteScreen))),
      TextDirection.rtl,
    );
  });

  group('against the backend', () {
    testWidgets('the token goes in the body of one POST — never in an '
        'address, the route, or anything shown', (tester) async {
      final server = CommunityServer({
        'GET /auth/me': (_) => jsonResponse(200, signedInUser),
        'POST /communities/join': (_) =>
            jsonResponse(201, communityJson(id: 'c-9', title: 'مجتمع مدعو')),
        'GET /communities/c-9': (_) =>
            jsonResponse(200, communityJson(id: 'c-9', title: 'مجتمع مدعو')),
        'GET /communities': (_) => jsonResponse(200, {
          'items': [communityJson(id: 'c-9', title: 'مجتمع مدعو')],
          'nextCursor': null,
        }),
      });
      container = await openApp(
        tester,
        '/invite',
        overrides: [
          ...backendOverrides(server, signedIn: true),
          startupInvitationTokenProvider.overrideWithValue(token),
        ],
      );
      final router = container.read(routerProvider);
      expect(
        router.routeInformationProvider.value.uri.toString(),
        isNot(contains(token)),
      );
      await tapJoin(tester);
      final joins = server.requests.where(
        (r) => r.url.path == '/communities/join',
      );
      expect(joins, hasLength(1));
      expect(joins.single.method, 'POST');
      expect(jsonDecode(joins.single.body), {'token': token});
      for (final request in server.requests) {
        expect(request.url.toString(), isNot(contains(token)));
      }
      expect(locationIn(container), '/communities/c-9');
      expect(find.text('مجتمع مدعو'), findsWidgets);
      expect(find.textContaining(token), findsNothing);
    });

    testWidgets('asks for a sign-in again when the server does, the link '
        'kept', (tester) async {
      final server = CommunityServer({
        'GET /auth/me': (_) => jsonResponse(200, signedInUser),
        'POST /communities/join': (_) =>
            refusal(401, 'identity.authentication_required'),
      });
      container = await openApp(
        tester,
        '/invite',
        overrides: [
          ...backendOverrides(server, signedIn: true),
          startupInvitationTokenProvider.overrideWithValue(token),
        ],
      );
      expect(find.text(CommunityCopy.invited), findsOneWidget);
      await tapJoin(tester);
      expect(find.text(CommunityCopy.signInToJoin), findsOneWidget);
      expect(held()?.token, token);
      expect(
        server.calls.where((c) => c == 'POST /communities/join'),
        hasLength(1),
      );
    });
  });
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/features/communities/community_invitations_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';
import 'community_test_support.dart';

/// The management screens in the real app: every action shown if and only
/// if the server's `me` holds it — never on the viewer's own row — asked
/// first where it cannot be taken back here, said in words without a
/// reason when refused, and never an id or a token on screen, but for the
/// new link itself, once.
void main() {
  const open = MockCommunityRepository.openId;
  const owned = MockCommunityRepository.ownedId;
  const teacherId = '${MockCommunityRepository.founder}-2';

  // Rows of the owned community, by the names the demo gives them.
  const viewerName = 'طالب تجريبي';
  const teacherName = 'الأستاذة عائشة';
  const studentName = 'فاطمة الأنصاري';

  late ScriptedCommunities repo;
  late ProviderContainer container;

  const signedIn = CurrentUser(
    id: viewer,
    displayName: viewerName,
    status: AccountStatus.active,
    roles: [],
    permissions: {},
  );

  Future<void> open_(
    WidgetTester tester,
    String path, {
    List<Override> extra = const [],
    bool signIn = true,
    Size size = const Size(390, 2000),
  }) async {
    container = await openApp(
      tester,
      path,
      size: size,
      overrides: [
        communityRepositoryProvider.overrideWithValue(repo),
        messagingRepositoryProvider.overrideWithValue(ScriptedMessaging()),
        if (signIn) sessionUserProvider.overrideWith((ref) async => signedIn),
        ...extra,
      ],
    );
  }

  setUp(() => repo = ScriptedCommunities());

  /// The button whose label is [label] — whichever kind it is.
  ButtonStyleButton button(WidgetTester tester, String label) =>
      tester.widget<ButtonStyleButton>(
        find
            .ancestor(
              of: find.text(label),
              matching: find.byWidgetPredicate((w) => w is ButtonStyleButton),
            )
            .first,
      );

  Finder inDialog(Finder finder) =>
      find.descendant(of: find.byType(AlertDialog), matching: finder);

  CommunityMember named(String? name) => CommunityMember(
    userId: 'x',
    displayName: name,
    active: true,
    joinedAt: DateTime.utc(2026),
  );

  /// A row's actions button, by the member's name.
  Finder options(String? name) =>
      find.byTooltip(CommunityCopy.memberOptions(named(name)));

  group('a community’s management, from me alone', () {
    const everyAction = [
      CommunityCopy.invitationLinks,
      CommunityCopy.lock,
      CommunityCopy.unlock,
      CommunityCopy.leave,
    ];

    for (final (what, capabilities, operations, status, shown)
        in <(String, List<String>, List<String>, String, Set<String>)>[
          ('nothing, for nothing held', [], [], 'OPEN', {}),
          ('leaving', [], ['community.leave'], 'OPEN', {CommunityCopy.leave}),
          (
            'the links, for members.invite',
            ['community.members.invite'],
            [],
            'OPEN',
            {CommunityCopy.invitationLinks},
          ),
          (
            'the links, for invitations.manage alone — locked too',
            [],
            ['community.invitations.manage'],
            'LOCKED',
            {CommunityCopy.invitationLinks},
          ),
          (
            'locking, for community.lock while open',
            ['community.lock'],
            [],
            'OPEN',
            {CommunityCopy.lock},
          ),
          (
            'unlocking, for community.lock while locked',
            ['community.lock'],
            [],
            'LOCKED',
            {CommunityCopy.unlock},
          ),
          (
            'neither lock nor unlock for a status it does not know',
            ['community.lock'],
            ['community.leave'],
            'ARCHIVED',
            {CommunityCopy.leave},
          ),
          (
            'nothing here for grants or handing over — those are a row’s',
            [],
            ['community.grants.manage', 'community.ownership.transfer'],
            'OPEN',
            {},
          ),
        ]) {
      testWidgets('offers $what', (tester) async {
        repo = AnsweredAs(
          communityJson(
            id: 'c-1',
            status: status,
            // An owner's standing alone offers nothing: only me's lists do.
            standing: 'OWNER',
            capabilities: capabilities,
            operations: operations,
          ),
        );
        await open_(tester, '/communities/c-1');
        for (final label in everyAction) {
          expect(
            find.text(label),
            shown.contains(label) ? findsOneWidget : findsNothing,
            reason: label,
          );
        }
        expect(
          find.text(CommunityCopy.managementTitle),
          shown.isEmpty ? findsNothing : findsOneWidget,
        );
      });
    }

    testWidgets('asks before locking — a no sends nothing — and unlocks '
        'without asking', (tester) async {
      await open_(tester, '/communities/$owned');
      await tester.tap(find.text(CommunityCopy.lock));
      await tester.pumpAndSettle();
      expect(inDialog(find.textContaining('مجتمع أسرة الحفظ')), findsOneWidget);
      await tester.tap(find.text(CommunityCopy.cancel));
      await tester.pumpAndSettle();
      expect(repo.writes, isEmpty);

      await tester.tap(find.text(CommunityCopy.lock));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.confirmLock));
      await tester.pumpAndSettle();
      expect(repo.writes, ['lock $owned']);
      expect(find.text(CommunityCopy.lockedNotice), findsOneWidget);
      expect(find.text(CommunityCopy.lock), findsNothing);

      await tester.tap(find.text(CommunityCopy.unlock));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(repo.writes, ['lock $owned', 'unlock $owned']);
      expect(find.text(CommunityCopy.lockedNotice), findsNothing);
      expect(find.text(CommunityCopy.lock), findsOneWidget);
    });

    testWidgets('one change at a time: the tapped button spins, and none '
        'sends again', (tester) async {
      await open_(tester, '/communities/$owned');
      final hold = repo.holdWrites = Completer<void>();
      await tester.tap(find.text(CommunityCopy.lock));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.confirmLock));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(button(tester, CommunityCopy.lock).onPressed, isNull);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await tester.tap(find.text(CommunityCopy.lock), warnIfMissed: false);
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.byType(AlertDialog), findsNothing);
      // Going to the links is not a change: it stays open.
      expect(
        button(tester, CommunityCopy.invitationLinks).onPressed,
        isNotNull,
      );
      hold.complete();
      await tester.pumpAndSettle();
      expect(repo.writes, ['lock $owned']);
      expect(button(tester, CommunityCopy.unlock).onPressed, isNotNull);
    });

    testWidgets('asks before leaving, then goes to the list — which no '
        'longer has it', (tester) async {
      await open_(tester, '/communities');
      await tester.tap(find.text('مجتمع طلاب التجويد'));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.leave));
      await tester.pumpAndSettle();
      expect(
        inDialog(find.textContaining('مجتمع طلاب التجويد')),
        findsOneWidget,
      );
      await tester.tap(find.text(CommunityCopy.confirmLeave));
      await tester.pumpAndSettle();
      expect(repo.writes, ['leave $open']);
      expect(locationIn(container), '/communities');
      expect(find.text('مجتمع طلاب التجويد'), findsNothing);
    });

    testWidgets('says a refusal without its reason, and follows me as the '
        'server now answers it', (tester) async {
      final answer = repo = AnsweredAs(
        communityJson(id: 'c-1', capabilities: ['community.lock']),
      );
      await open_(tester, '/communities/c-1');
      // The right is gone; the server refuses the lock and answers without
      // it.
      answer
        ..json = communityJson(id: 'c-1')
        ..failWritesWith = 'communities.capability_required';
      await tester.tap(find.text(CommunityCopy.lock));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.confirmLock));
      await tester.pumpAndSettle();
      expect(
        find.text(CommunityCopy.writeFailed('communities.capability_required')),
        findsOneWidget,
      );
      expect(find.text(CommunityCopy.lock), findsNothing);
      expect(find.text(CommunityCopy.managementTitle), findsNothing);
    });
  });

  group('a roster row’s actions', () {
    testWidgets('are on every row but the viewer’s own', (tester) async {
      await open_(tester, '/communities/$owned/members');
      expect(options(teacherName), findsOneWidget);
      expect(options(studentName), findsOneWidget);
      expect(options(null), findsOneWidget); // a member with no name
      expect(options(viewerName), findsNothing);
      expect(find.text(viewerName), findsOneWidget);
    });

    testWidgets('are on no row while nobody is known to be the viewer', (
      tester,
    ) async {
      await open_(tester, '/communities/$owned/members', signIn: false);
      expect(find.text(studentName), findsOneWidget);
      expect(find.byIcon(Icons.more_vert_rounded), findsNothing);
    });

    for (final (what, capabilities, operations, shown)
        in <(String, List<String>, List<String>, Set<String>)>[
          (
            'removing, for members.remove',
            ['community.members.view', 'community.members.remove'],
            [],
            {CommunityCopy.removeMember},
          ),
          (
            'capabilities, for grants.manage',
            ['community.members.view'],
            ['community.grants.manage'],
            {CommunityCopy.memberCapabilities},
          ),
          (
            'handing over, for ownership.transfer',
            ['community.members.view'],
            ['community.ownership.transfer'],
            {CommunityCopy.makeOwner},
          ),
          ('nothing, for the roster alone', ['community.members.view'], [], {}),
        ]) {
      testWidgets('offer $what — and nothing else', (tester) async {
        repo = AnsweredAs(
          communityJson(
            id: owned,
            standing: 'OWNER',
            capabilities: capabilities,
            operations: operations,
          ),
        );
        await open_(tester, '/communities/$owned/members');
        if (shown.isEmpty) {
          expect(find.byIcon(Icons.more_vert_rounded), findsNothing);
          return;
        }
        await tester.tap(options(studentName));
        await tester.pumpAndSettle();
        for (final label in [
          CommunityCopy.memberCapabilities,
          CommunityCopy.makeOwner,
          CommunityCopy.removeMember,
        ]) {
          expect(
            find.text(label),
            shown.contains(label) ? findsOneWidget : findsNothing,
            reason: label,
          );
        }
      });
    }

    testWidgets('ask before removing, naming the member — then the row is '
        'gone', (tester) async {
      await open_(tester, '/communities/$owned/members');
      await tester.tap(options(studentName));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.removeMember));
      await tester.pumpAndSettle();
      expect(inDialog(find.textContaining(studentName)), findsOneWidget);
      await tester.tap(find.text(CommunityCopy.cancel));
      await tester.pumpAndSettle();
      expect(repo.writes, isEmpty);

      await tester.tap(options(studentName));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.removeMember));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.confirmRemove));
      await tester.pumpAndSettle();
      expect(repo.writes, ['removeMember $owned $owned-member-3']);
      expect(find.text(studentName), findsNothing);
    });

    testWidgets('name a member without a name with the neutral word — never '
        'an id', (tester) async {
      await open_(tester, '/communities/$owned/members');
      await tester.tap(options(null));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.removeMember));
      await tester.pumpAndSettle();
      expect(
        inDialog(find.text(CommunityCopy.removeQuestion(named(null)))),
        findsOneWidget,
      );
      expect(find.textContaining('mock-'), findsNothing);
    });

    testWidgets('hand the community over, then show the viewer’s standing '
        'as the server now answers it', (tester) async {
      await open_(tester, '/communities/$owned');
      await tester.tap(find.text(CommunityCopy.viewMembers));
      await tester.pumpAndSettle();
      await tester.tap(options(teacherName));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.makeOwner));
      await tester.pumpAndSettle();
      expect(inDialog(find.textContaining(teacherName)), findsOneWidget);
      await tester.tap(find.text(CommunityCopy.confirmTransfer));
      await tester.pumpAndSettle();
      expect(repo.writes, ['transferOwnership $owned $teacherId']);
      expect(locationIn(container), '/communities/$owned');
      expect(find.text(CommunityCopy.ownershipTransferred), findsOneWidget);
      expect(find.text('مالك المجتمع'), findsNothing);
      expect(find.text(CommunityCopy.leave), findsOneWidget);
      expect(find.text(CommunityCopy.lock), findsNothing);
    });

    testWidgets('say a refused hand-over without its reason, and stay', (
      tester,
    ) async {
      await open_(tester, '/communities/$owned/members');
      await tester.tap(options(studentName));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.makeOwner));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.confirmTransfer));
      await tester.pumpAndSettle();
      expect(
        find.text(CommunityCopy.writeFailed('communities.owner_ineligible')),
        findsOneWidget,
      );
      expect(locationIn(container), '/communities/$owned/members');
    });
  });

  group('a member’s capabilities', () {
    Future<void> openCapabilities(WidgetTester tester, String name) async {
      await tester.tap(options(name));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.memberCapabilities));
      await tester.pumpAndSettle();
    }

    testWidgets('are the server’s list: granted, or not; the chosen granted '
        'in one request, one revoked', (tester) async {
      await open_(tester, '/communities/$owned/members');
      await openCapabilities(tester, teacherName);
      expect(
        find.text(CommunityCopy.capabilitiesOf(named(teacherName))),
        findsOneWidget,
      );
      expect(find.text(CommunityCopy.granted), findsOneWidget);
      expect(find.text(CommunityCopy.notGranted), findsNWidgets(6));
      expect(
        button(tester, CommunityCopy.grantChosen).onPressed,
        isNull, // nothing chosen yet
      );

      await tester.tap(
        find.text(CommunityCopy.capability(CommunityCapability.membersInvite)),
      );
      await tester.tap(
        find.text(CommunityCopy.capability(CommunityCapability.lock)),
      );
      await tester.pump();
      await tester.tap(find.text(CommunityCopy.grantChosen));
      await tester.pumpAndSettle();
      expect(repo.writes, ['grant $owned $teacherId']);
      expect(find.text(CommunityCopy.granted), findsNWidgets(3));

      await tester.tap(
        find.byTooltip(
          CommunityCopy.revokeGrantTooltip(CommunityCapability.membersInvite),
        ),
      );
      await tester.pumpAndSettle();
      expect(repo.writes.last, startsWith('revokeGrant $owned '));
      expect(find.text(CommunityCopy.granted), findsNWidgets(2));
      expect(find.textContaining('mock-'), findsNothing);
    });

    testWidgets('say a grant not in effect now in neutral words', (
      tester,
    ) async {
      repo = _DormantGrants();
      await open_(tester, '/communities/$owned/members');
      await openCapabilities(tester, teacherName);
      expect(find.text(CommunityCopy.grantedDormant), findsOneWidget);
      expect(find.text(CommunityCopy.notGranted), findsNWidgets(6));
      expect(find.textContaining('grant-'), findsNothing);
    });

    testWidgets('say a refused grant in the sheet, without its reason', (
      tester,
    ) async {
      await open_(tester, '/communities/$owned/members');
      await openCapabilities(tester, studentName);
      await tester.tap(
        find.text(CommunityCopy.capability(CommunityCapability.lock)),
      );
      await tester.pump();
      await tester.tap(find.text(CommunityCopy.grantChosen));
      await tester.pumpAndSettle();
      expect(
        find.text(CommunityCopy.writeFailed('communities.grantee_ineligible')),
        findsOneWidget,
      );
    });

    testWidgets('stop being offered once me no longer allows them', (
      tester,
    ) async {
      final realtime = FakeRealtimeClient();
      final answer = repo = AnsweredAs(
        communityJson(
          id: owned,
          capabilities: ['community.members.view'],
          operations: ['community.grants.manage'],
        ),
      );
      await open_(
        tester,
        '/communities/$owned/members',
        extra: [realtimeConnectionProvider.overrideWithValue(realtime)],
      );
      await openCapabilities(tester, teacherName);
      expect(find.text(CommunityCopy.granted), findsOneWidget);
      answer.json = communityJson(
        id: owned,
        capabilities: ['community.members.view'],
      );
      realtime.emit(accessChanged(owned));
      await tester.pumpAndSettle();
      expect(find.text(CommunityCopy.notYours), findsOneWidget);
      expect(find.text(CommunityCopy.grantChosen), findsNothing);
      expect(find.text(CommunityCopy.revokeGrant), findsNothing);
    });
  });

  group('the invitation links', () {
    Uri webLink(String token) =>
        Uri.parse('https://example.org/app/invite').replace(fragment: token);
    final web = [inviteLinkBuilderProvider.overrideWithValue(webLink)];

    /// What the clipboard was given; [fail] makes it refuse, as a browser
    /// outside a secure context does.
    List<String> clipboard(WidgetTester tester, {bool fail = false}) {
      final copied = <String>[];
      final messenger = tester.binding.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method != 'Clipboard.setData') return null;
        if (fail) throw PlatformException(code: 'copy_fail');
        copied.add((call.arguments as Map)['text'] as String);
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
      );
      return copied;
    }

    testWidgets('are listed as the server gives them — the viewer’s own '
        'marked, never a token or an id', (tester) async {
      await open_(tester, '/communities/$owned/invitations');
      expect(
        find.text(CommunityCopy.invitationState(InvitationState.active)),
        findsOneWidget,
      );
      expect(
        find.text(CommunityCopy.invitationState(InvitationState.expired)),
        findsOneWidget,
      );
      expect(find.text('مرات الاستخدام: 4 من 30'), findsOneWidget);
      expect(find.text('مرات الاستخدام: 9'), findsOneWidget);
      expect(find.text(CommunityCopy.createdByYou), findsNWidgets(2));
      expect(find.byTooltip(CommunityCopy.revokeLink), findsNWidgets(2));
      expect(find.textContaining('مجتمع أسرة الحفظ'), findsOneWidget);
      expect(find.textContaining('mock-'), findsNothing);
      expect(find.text(CommunityCopy.demoInvitations), findsOneWidget);
    });

    testWidgets('call no link the viewer’s while nobody is known', (
      tester,
    ) async {
      await open_(tester, '/communities/$owned/invitations', signIn: false);
      expect(find.text(CommunityCopy.createdByYou), findsNothing);
    });

    testWidgets('are made in the web app only: elsewhere a note says so', (
      tester,
    ) async {
      await open_(tester, '/communities/$owned/invitations');
      expect(find.text(CommunityCopy.createLink), findsNothing);
      expect(find.text(CommunityCopy.linksOnWeb), findsOneWidget);
    });

    testWidgets('a new one is made once, shown once — to copy — and '
        'forgotten when closed', (tester) async {
      final copied = clipboard(tester);
      await open_(tester, '/communities/$owned/invitations', extra: web);
      expect(find.text(CommunityCopy.linksOnWeb), findsNothing);
      await tester.tap(find.text(CommunityCopy.createLink));
      await tester.pumpAndSettle();
      expect(repo.writes, ['createInvitation $owned']);
      final shown = tester
          .widget<SelectableText>(find.byType(SelectableText))
          .data!;
      final token = Uri.parse(shown).fragment;
      expect(isInvitationTokenShaped(token), isTrue);
      expect(shown, webLink(token).toString());
      expect(find.text(CommunityCopy.linkSheetNote), findsOneWidget);

      await tester.tap(find.text(CommunityCopy.copyLink));
      await tester.pumpAndSettle();
      expect(copied, [shown]);
      expect(find.text(CommunityCopy.linkCopied), findsOneWidget);

      await tester.tap(find.text(CommunityCopy.done));
      await tester.pumpAndSettle();
      expect(find.textContaining(token), findsNothing);
      expect(find.byType(SelectableText), findsNothing);
      // Listed now, as any other — without its token.
      expect(
        find.text(CommunityCopy.invitationState(InvitationState.active)),
        findsNWidgets(2),
      );
      expect(repo.writes, ['createInvitation $owned']);
    });

    testWidgets('a new one stays on screen to select when the clipboard '
        'refuses', (tester) async {
      clipboard(tester, fail: true);
      await open_(tester, '/communities/$owned/invitations', extra: web);
      await tester.tap(find.text(CommunityCopy.createLink));
      await tester.pumpAndSettle();
      await tester.tap(find.text(CommunityCopy.copyLink));
      await tester.pumpAndSettle();
      expect(find.text(CommunityCopy.copyFailed), findsOneWidget);
      expect(find.byType(SelectableText), findsOneWidget);
    });

    testWidgets('a refused new link is said, and nothing is shown', (
      tester,
    ) async {
      await open_(tester, '/communities/$owned/invitations', extra: web);
      repo.failWritesWith = 'communities.too_many_invitations';
      await tester.tap(find.text(CommunityCopy.createLink));
      await tester.pumpAndSettle();
      expect(
        find.text(
          CommunityCopy.writeFailed('communities.too_many_invitations'),
        ),
        findsOneWidget,
      );
      expect(find.byType(SelectableText), findsNothing);
    });

    testWidgets('are revoked after asking, and shown revoked', (tester) async {
      await open_(tester, '/communities/$owned/invitations');
      await tester.tap(find.byTooltip(CommunityCopy.revokeLink).first);
      await tester.pumpAndSettle();
      expect(
        inDialog(find.text(CommunityCopy.revokeLinkQuestion)),
        findsOneWidget,
      );
      await tester.tap(inDialog(find.text(CommunityCopy.revokeLink)));
      await tester.pumpAndSettle();
      expect(repo.writes.single, startsWith('revokeInvitation $owned '));
      expect(
        find.text(CommunityCopy.invitationState(InvitationState.revoked)),
        findsOneWidget,
      );
      expect(find.byTooltip(CommunityCopy.revokeLink), findsOneWidget);
    });

    testWidgets('offer revoking from invitations.manage alone', (tester) async {
      repo = AnsweredAs(
        communityJson(
          id: owned,
          status: 'LOCKED',
          operations: ['community.invitations.manage'],
        ),
      );
      await open_(tester, '/communities/$owned/invitations', extra: web);
      expect(find.byTooltip(CommunityCopy.revokeLink), findsNWidgets(2));
      expect(find.text(CommunityCopy.createLink), findsNothing);
      expect(find.text(CommunityCopy.linksOnWeb), findsNothing);
    });

    testWidgets('offer a new link from members.invite alone', (tester) async {
      repo = AnsweredAs(
        communityJson(id: owned, capabilities: ['community.members.invite']),
      );
      await open_(tester, '/communities/$owned/invitations', extra: web);
      expect(find.text(CommunityCopy.createLink), findsOneWidget);
      expect(find.byTooltip(CommunityCopy.revokeLink), findsNothing);
    });

    testWidgets('say "not yours", "gone", "none yet" — and a failure with '
        'a retry', (tester) async {
      await open_(tester, '/communities/$open/invitations');
      expect(find.text(CommunityCopy.invitationsForbidden), findsOneWidget);

      container.read(routerProvider).go('/communities/nowhere/invitations');
      await tester.pumpAndSettle();
      expect(find.text(CommunityCopy.gone), findsOneWidget);

      repo.delegate(open, {
        CommunityCapability.membersView,
        CommunityCapability.membersInvite,
      });
      container.read(routerProvider).go('/communities/$open/invitations');
      await tester.pumpAndSettle();
      expect(find.text(CommunityCopy.invitationsEmpty), findsOneWidget);

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
    });

    testWidgets('read right to left', (tester) async {
      await open_(tester, '/communities/$owned/invitations');
      expect(
        Directionality.of(
          tester.element(find.byType(CommunityInvitationsScreen)),
        ),
        TextDirection.rtl,
      );
    });
  });

  group('what a refusal says', () {
    const refusals = [
      'communities.capability_required',
      'identity.permission_denied',
      'communities.not_community_owner',
      'communities.member_holds_more_capabilities',
      'communities.owner_not_removable',
      'communities.cannot_remove_self',
      'communities.owner_ineligible',
      'communities.owner_self_assignment',
      'communities.owner_cannot_leave',
      'communities.grantee_ineligible',
      'communities.community_locked',
      'communities.member_not_found',
      'communities.invitation_not_found',
      'communities.grant_not_found',
      'communities.conflict',
      'communities.owner_conflict',
      'communities.too_many_invitations',
      'communities.too_many_grants',
      'unavailable',
      'network.unreachable',
    ];
    const joining = [
      'communities.invitation_invalid',
      'communities.invitation_revoked',
      'communities.invitation_expired',
      'communities.invitation_exhausted',
      'communities.rejoin_requires_manager',
      'communities.community_locked',
      'communities.too_many_attempts',
      'communities.conflict',
      'unavailable',
      'network.unreachable',
    ];

    test('never says why: who owns, who may leave, what a lock closes, '
        'who removed whom', () {
      for (final code in [
        'communities.owner_not_removable',
        'communities.owner_cannot_leave',
        'communities.owner_ineligible',
        'communities.owner_self_assignment',
        'communities.not_community_owner',
      ]) {
        expect(CommunityCopy.writeFailed(code), isNot(contains('مالك')));
      }
      expect(
        CommunityCopy.writeFailed('communities.community_locked'),
        isNot(contains('قفل')),
      );
      expect(
        CommunityCopy.joinFailed('communities.community_locked'),
        isNot(contains('قفل')),
      );
      final rejoin = CommunityCopy.joinFailed(
        'communities.rejoin_requires_manager',
      );
      for (final word in ['أزيل', 'أُزيل', 'إزالة', 'مشرف', 'مدير']) {
        expect(rejoin, isNot(contains(word)));
      }
      expect(
        CommunityCopy.writeFailed('communities.member_holds_more_capabilities'),
        isNot(contains('صلاحي')),
      );
    });

    test('is always words — never a code, and never the generic line for a '
        'code it knows', () {
      final latin = RegExp('[A-Za-z]');
      for (final code in refusals) {
        final said = CommunityCopy.writeFailed(code);
        expect(said, isNot(matches(latin)), reason: code);
        expect(said, isNot(CommunityCopy.writeFailed('x.unknown')));
      }
      for (final code in joining) {
        final said = CommunityCopy.joinFailed(code);
        expect(said, isNot(matches(latin)), reason: code);
        expect(said, isNot(CommunityCopy.joinFailed('x.unknown')));
      }
    });
  });
}

/// The scripted server, but every member's grants are one the server keeps
/// and does not apply now.
class _DormantGrants extends ScriptedCommunities {
  @override
  Future<GrantPage> grants(
    String communityId, {
    required String userId,
    String? cursor,
  }) async {
    grantRequests.add(userId);
    return GrantPage(
      items: [
        CommunityGrant(
          grantId: 'grant-1',
          userId: userId,
          capability: CommunityCapability.liveModerate,
          grantedAt: DateTime.utc(2026, 9, 1),
          dormant: true,
        ),
      ],
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/features/communities/state/pending_invitation.dart';
import 'package:quran_institution_app/features/communities/widgets/member_capabilities_sheet.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'community_test_support.dart';

/// All of P5.1 in the demo app, walked as a person would, on the app's own
/// wiring — its mock community server (with its latency), its mock sign-in
/// — a browser's link builder the only stand-in: opened by a link, signed
/// in, joined; then, in the community they own, a link made, copied and
/// revoked, the community locked and unlocked, a member's capabilities
/// granted and revoked, the community handed over; and a community left.
void main() {
  testWidgets('the demo, end to end', (tester) async {
    final copied = <String>[];
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        copied.add((call.arguments as Map)['text'] as String);
      }
      return null;
    });
    addTearDown(
      () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
    );

    final container = await openApp(
      tester,
      '/invite',
      size: const Size(390, 1600),
      overrides: [
        startupInvitationTokenProvider.overrideWithValue(
          MockCommunityRepository.demoActiveToken,
        ),
        inviteLinkBuilderProvider.overrideWithValue(
          (token) =>
              Uri.parse('https://example.org/app/invite')
                  .replace(fragment: token),
        ),
      ],
    );
    String location() => locationIn(container);

    Future<void> tap(Finder finder) async {
      if (finder.evaluate().isEmpty) {
        await tester.scrollUntilVisible(
          finder,
          300,
          scrollable: find.byType(Scrollable).first,
        );
      }
      await tester.ensureVisible(finder.first);
      await tester.pumpAndSettle();
      await tester.tap(finder.first);
      await tester.pumpAndSettle();
    }

    Future<void> tapText(String text) => tap(find.text(text));

    Finder options(String name) => find.byTooltip(
      CommunityCopy.memberOptions(
        CommunityMember(
          userId: 'x',
          displayName: name,
          active: true,
          joinedAt: DateTime.utc(2026),
        ),
      ),
    );

    // ── Opened by a link: sign in, then join ─────────────────────────────
    expect(find.text(CommunityCopy.signInToJoin), findsOneWidget);
    await tapText('تسجيل الدخول');
    await tester.enterText(find.byType(TextField).at(0), 'student@example.org');
    await tester.enterText(find.byType(TextField).at(1), 'secret');
    await tapText('دخول');
    expect(location(), '/invite');
    await tapText(CommunityCopy.join);
    expect(location(), '/communities/${MockCommunityRepository.invitedId}');
    expect(find.text('مجتمع حلقة الفجر'), findsWidgets);
    expect(container.read(pendingInvitationProvider), isNull);

    // ── The community the viewer owns: its links ──────────────────────────
    container.read(routerProvider).go('/communities');
    await tester.pumpAndSettle();
    expect(find.text('مجتمع حلقة الفجر'), findsOneWidget); // listed now
    await tapText('مجتمع أسرة الحفظ');
    await tapText(CommunityCopy.invitationLinks);
    expect(
      location(),
      '/communities/${MockCommunityRepository.ownedId}/invitations',
    );
    expect(find.text(CommunityCopy.createdByYou), findsNWidgets(2));
    await tapText(CommunityCopy.createLink);
    final link = tester
        .widget<SelectableText>(find.byType(SelectableText))
        .data!;
    expect(link, startsWith('https://example.org/app/invite#'));
    await tapText(CommunityCopy.copyLink);
    expect(copied, [link]);
    await tapText(CommunityCopy.done);
    expect(find.textContaining(link), findsNothing);
    final active = CommunityCopy.invitationState(InvitationState.active);
    expect(find.text(active), findsNWidgets(2));
    await tap(find.byTooltip(CommunityCopy.revokeLink).first);
    await tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.text(CommunityCopy.revokeLink),
      ),
    );
    expect(find.text(active), findsOneWidget);
    expect(
      find.text(CommunityCopy.invitationState(InvitationState.revoked)),
      findsOneWidget,
    );
    container.read(routerProvider).pop();
    await tester.pumpAndSettle();

    // ── Locked, and unlocked ──────────────────────────────────────────────
    await tapText(CommunityCopy.lock);
    await tapText(CommunityCopy.confirmLock);
    expect(find.text(CommunityCopy.lockedNotice), findsOneWidget);
    await tapText(CommunityCopy.unlock);
    expect(find.text(CommunityCopy.lockedNotice), findsNothing);

    // ── A member's capabilities: granted, and revoked ────────────────────
    await tapText(CommunityCopy.viewMembers);
    await tap(options('الأستاذة عائشة'));
    await tapText(CommunityCopy.memberCapabilities);
    expect(find.text(CommunityCopy.granted), findsOneWidget);
    await tapText(CommunityCopy.capability(CommunityCapability.membersInvite));
    await tapText(CommunityCopy.grantChosen);
    expect(find.text(CommunityCopy.granted), findsNWidgets(2));
    await tap(
      find.byTooltip(
        CommunityCopy.revokeGrantTooltip(CommunityCapability.membersInvite),
      ),
    );
    expect(find.text(CommunityCopy.granted), findsOneWidget);
    Navigator.of(tester.element(find.byType(MemberCapabilitiesSheet))).pop();
    await tester.pumpAndSettle();

    // ── Handed over: the viewer's standing, as the server answers it ──────
    await tap(options('الأستاذة عائشة'));
    await tapText(CommunityCopy.makeOwner);
    await tapText(CommunityCopy.confirmTransfer);
    expect(location(), '/communities/${MockCommunityRepository.ownedId}');
    expect(find.text('مالك المجتمع'), findsNothing);
    expect(find.text(CommunityCopy.leave), findsOneWidget);

    // ── A community left ──────────────────────────────────────────────────
    container.read(routerProvider).go('/communities');
    await tester.pumpAndSettle();
    await tapText('مجتمع طلاب التجويد');
    await tapText(CommunityCopy.leave);
    await tapText(CommunityCopy.confirmLeave);
    expect(location(), '/communities');
    expect(find.text('مجتمع طلاب التجويد'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}

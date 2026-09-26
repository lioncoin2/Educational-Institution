import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/features/communities/state/pending_invitation.dart';
import 'package:quran_institution_app/main.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// The one place an invitation's token is held: in memory, one at a time,
/// the latest offered — the link the page was opened with from the start,
/// then each one opened while the app runs, handed over as main() hands
/// them (its overrides).
void main() {
  final token = 'A' * 43;
  final second = 'B' * 43;

  ProviderContainer container({String? atStartup, Stream<String>? later}) {
    final c = ProviderContainer(
      overrides: invitationOverrides(
        atStartup: atStartup,
        later: later ?? const Stream<String>.empty(),
      ),
    );
    addTearDown(c.dispose);
    return c;
  }

  test('holds nothing without a link', () {
    expect(container().read(pendingInvitationProvider), isNull);
    // Nor without main(): the providers' own defaults hold none either.
    final bare = ProviderContainer();
    addTearDown(bare.dispose);
    expect(bare.read(pendingInvitationProvider), isNull);
  });

  test('starts with the link the page was opened with', () {
    final held = container(atStartup: token).read(pendingInvitationProvider);
    expect(held?.token, token);
  });

  test(
    'takes each link opened later — the same one again is a new offer',
    () async {
      final later = StreamController<String>.broadcast();
      addTearDown(later.close);
      final c = container(atStartup: token, later: later.stream);
      final seen = <PendingInvitation?>[];
      c.listen(pendingInvitationProvider, (_, next) => seen.add(next));
      final first = c.read(pendingInvitationProvider)!;

      later.add(second);
      await pumpEventQueue();
      final next = c.read(pendingInvitationProvider)!;
      expect(next.token, second);
      expect(next.serial, greaterThan(first.serial));

      later.add(second);
      await pumpEventQueue();
      expect(
        c.read(pendingInvitationProvider)!.serial,
        greaterThan(next.serial),
      );
      expect(seen, hasLength(2)); // each offer told, the repeat included
    },
  );

  test('offers and forgets on request', () {
    final c = container();
    final holder = c.read(pendingInvitationProvider.notifier);
    holder.offer(token);
    expect(c.read(pendingInvitationProvider)?.token, token);
    holder.clear();
    expect(c.read(pendingInvitationProvider), isNull);
  });

  test(
    'never brings a used startup token back — not even built again',
    () async {
      final later = StreamController<String>.broadcast();
      addTearDown(later.close);
      final c = container(atStartup: token, later: later.stream);
      expect(c.read(pendingInvitationProvider)?.token, token);
      c.read(pendingInvitationProvider.notifier).clear();

      c.invalidate(pendingInvitationProvider);
      expect(c.read(pendingInvitationProvider), isNull);

      // Still listening — once, not twice.
      final seen = <PendingInvitation?>[];
      c.listen(pendingInvitationProvider, (_, next) => seen.add(next));
      later.add(second);
      await pumpEventQueue();
      expect(c.read(pendingInvitationProvider)?.token, second);
      expect(seen, hasLength(1));
    },
  );

  test('stops listening when the app is done', () {
    final later = StreamController<String>.broadcast();
    addTearDown(later.close);
    final c = ProviderContainer(
      overrides: invitationOverrides(atStartup: null, later: later.stream),
    );
    c.read(pendingInvitationProvider);
    expect(later.hasListener, isTrue);
    c.dispose();
    expect(later.hasListener, isFalse);
  });

  test('keeps it in memory only: another start holds nothing', () {
    container().read(pendingInvitationProvider.notifier).offer(token);
    expect(container().read(pendingInvitationProvider), isNull);
  });

  test('tells a token’s shape from anything else', () {
    expect(PendingInvitation(serial: 1, token: token).isWellFormed, isTrue);
    for (final malformed in ['', 'A' * 42, '${'A' * 42}=', '${'A' * 42}/']) {
      expect(
        PendingInvitation(serial: 1, token: malformed).isWellFormed,
        isFalse,
        reason: malformed,
      );
    }
  });

  testWidgets(
    'reaches the app through its ProviderScope, as main() starts it',
    (tester) async {
      final later = StreamController<String>.broadcast();
      addTearDown(later.close);
      await tester.pumpWidget(
        ProviderScope(
          overrides: invitationOverrides(atStartup: token, later: later.stream),
          child: const QuranInstitutionApp(),
        ),
      );
      final scope = ProviderScope.containerOf(
        tester.element(find.byType(QuranInstitutionApp)),
      );
      expect(scope.read(pendingInvitationProvider)?.token, token);

      later.add(second);
      await tester.pump();
      expect(scope.read(pendingInvitationProvider)?.token, second);

      // Let the splash timer run out, as every app test does.
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
    },
  );

  test('writes no link off the web — and a test may stand in for one', () {
    expect(container().read(inviteLinkBuilderProvider), isNull);

    final web = ProviderContainer(
      overrides: [
        inviteLinkBuilderProvider.overrideWithValue(
          (token) => Uri.parse('https://example.org/app/invite#$token'),
        ),
      ],
    );
    addTearDown(web.dispose);
    expect(
      web.read(inviteLinkBuilderProvider)!(token).toString(),
      'https://example.org/app/invite#$token',
    );
  });
}

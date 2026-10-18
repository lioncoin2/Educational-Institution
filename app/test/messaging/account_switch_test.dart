import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/models/notifications.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/messaging/state/conversation_list_controller.dart';
import 'package:quran_institution_app/features/messaging/state/conversation_mutes_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';

/// One browser, two people: A signs out and B signs in on the same tab. The
/// conversation list and the mute set are kept alive for the whole app (they
/// are not auto-disposed), so nothing of A's may survive into B's session —
/// not A's conversations, not A's viewer id, not A's muted set.
///
/// Both fakes answer as whoever is signed in right now, the way the server
/// does: by the bearer token the request carries.
String? _signedIn;

/// When set, account B's reads fail (a transient outage) — its first read
/// then leaves the previous account's value as Riverpod's `previous`.
bool _bFails = false;

/// When set, account A's reads wait for it: a request still in flight when
/// A signs out and B signs in.
Completer<void>? _aSlow;

CurrentUser _user(String id) => CurrentUser(
  id: id,
  displayName: id,
  status: AccountStatus.active,
  roles: const [],
  permissions: const {},
);

class _PerAccountMessaging extends MockMessagingRepository {
  _PerAccountMessaging() : super(latency: Duration.zero);

  @override
  Future<String> viewerId() async => _signedIn ?? 'nobody';

  @override
  Future<ConversationPage> conversations({String? cursor}) async {
    final asWho = _signedIn; // the account whose token the request carries
    if (asWho == null) {
      throw const MessagingException(
        'identity.authentication_required',
        'signed out',
      );
    }
    if (asWho == 'account-b') {
      if (_bFails) throw const MessagingException('unavailable', 'outage');
      return const ConversationPage(items: []); // B has none at all
    }
    // A has the demo conversations: the first one, then the rest as page 2.
    final all = (await super.conversations()).items;
    final slow = _aSlow;
    if (slow != null) await slow.future;
    return cursor == null
        ? ConversationPage(items: all.take(1).toList(), nextCursor: 'a-2')
        : ConversationPage(items: all.skip(1).toList());
  }
}

class _PerAccountMutes implements NotificationsRepository {
  final Map<String, Set<String>> mutedBy = {
    'account-a': {'conversation-of-a'},
    'account-b': {},
  };

  @override
  Future<Set<String>> mutedConversations() async {
    final who = _signedIn;
    if (who == null) {
      throw const NotificationsException(
        'identity.authentication_required',
        'signed out',
      );
    }
    if (who == 'account-b' && _bFails) {
      throw const NotificationsException('unavailable', 'outage');
    }
    return Set.of(mutedBy[who]!);
  }

  final List<String> muted = [];

  @override
  Future<void> muteConversation(String conversationId) async =>
      muted.add(conversationId);

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

void main() {
  late ProviderContainer container;
  late FakeRealtimeClient realtime;
  late _PerAccountMutes mutes;

  setUp(() {
    _signedIn = 'account-a';
    _bFails = false;
    _aSlow = null;
    realtime = FakeRealtimeClient();
    mutes = _PerAccountMutes();
    container = ProviderContainer(
      overrides: [
        messagingRepositoryProvider.overrideWithValue(_PerAccountMessaging()),
        notificationsRepositoryProvider.overrideWithValue(mutes),
        realtimeConnectionProvider.overrideWithValue(realtime),
        sessionUserProvider.overrideWith(
          (ref) async => _signedIn == null ? null : _user(_signedIn!),
        ),
      ],
    );
    addTearDown(container.dispose);
  });

  /// What the app does on sign-out and sign-in: the session is read again.
  Future<void> switchTo(String? account) async {
    _signedIn = account;
    container.invalidate(sessionUserProvider);
    await container.read(sessionUserProvider.future);
    await pumpEventQueue();
  }

  test('the conversation list is read again for the next account — '
      'none of the previous account\'s conversations remain', () async {
    await container.read(sessionUserProvider.future);
    final ofA = await container.read(conversationListProvider.future);
    expect(ofA.items, isNotEmpty);

    await switchTo(null);
    await switchTo('account-b');

    final ofB = await container.read(conversationListProvider.future);
    expect(ofB.items, isEmpty);
  });

  test('signed out, the list holds nothing of the account that left', () async {
    await container.read(sessionUserProvider.future);
    await container.read(conversationListProvider.future);

    await switchTo(null);

    // Read again as nobody: it fails (the server refuses), holding no data.
    await expectLater(
      container.read(conversationListProvider.future),
      throwsA(anything),
    );
    // What a screen renders (AsyncView → `when`) is the error, never the
    // previous account's list (Riverpod keeps it only as `previous`).
    final shown = container
        .read(conversationListProvider)
        .when(
          data: (_) => 'data',
          loading: () => 'loading',
          error: (_, _) => 'error',
        );
    expect(shown, 'error');
  });

  test('the mute set is the signed-in account\'s own — '
      'read again when the account changes', () async {
    await container.read(sessionUserProvider.future);
    expect(await container.read(conversationMutesProvider.future), {
      'conversation-of-a',
    });

    await switchTo(null);
    await switchTo('account-b');

    expect(await container.read(conversationMutesProvider.future), isEmpty);
  });

  // Found by the adversarial review: the notifier outlives a rebuild, so a
  // request asked for as A and answered after B signed in used to land in B's
  // inbox. Every answer is now checked against the build that asked for it.
  group('a request still in flight when the account changes', () {
    test('a quiet resync asked for as A is dropped, not shown to B', () async {
      await container.read(sessionUserProvider.future);
      container.listen(conversationListProvider, (_, _) {});
      await container.read(conversationListProvider.future);
      _aSlow = Completer<void>();
      realtime.setStatus(RealtimeStatus.connected); // reconnect → resync, as A
      await pumpEventQueue();

      await switchTo(null);
      await switchTo('account-b');
      expect(
        (await container.read(conversationListProvider.future)).items,
        isEmpty,
      );
      _aSlow!.complete();
      await pumpEventQueue();

      expect(
        container.read(conversationListProvider).requireValue.items,
        isEmpty,
      );
    });

    test(
      'a next page asked for as A is dropped, not appended to B\'s list',
      () async {
        await container.read(sessionUserProvider.future);
        container.listen(conversationListProvider, (_, _) {});
        await container.read(conversationListProvider.future);
        _aSlow = Completer<void>();
        final pending = container
            .read(conversationListProvider.notifier)
            .loadMore();

        await switchTo(null);
        await switchTo('account-b');
        expect(
          (await container.read(conversationListProvider.future)).items,
          isEmpty,
        );
        _aSlow!.complete();
        await pending;
        await pumpEventQueue();

        final ofB = container.read(conversationListProvider).requireValue;
        expect(ofB.items, isEmpty);
        expect(ofB.loadingMore, isFalse);
      },
    );
  });

  // A rebuild keeps the last account's value inside its loading or error state
  // (Riverpod's `previous`); no update may be computed from it.
  group('the previous account\'s value is never built upon', () {
    test(
      'B\'s first read failed: a read receipt does not bring A\'s inbox back',
      () async {
        await container.read(sessionUserProvider.future);
        container.listen(conversationListProvider, (_, _) {});
        final ofA = await container.read(conversationListProvider.future);
        final ids = ofA.items.map((c) => c.id).toList();
        await switchTo(null);
        _bFails = true;
        await switchTo('account-b');
        await expectLater(
          container.read(conversationListProvider.future),
          throwsA(anything),
        );

        container
            .read(conversationListProvider.notifier)
            .markedRead(ids.first, 1);

        final shown = container
            .read(conversationListProvider)
            .when(
              data: (state) => state.items.map((c) => c.id).toList(),
              loading: () => const <String>[],
              error: (_, _) => const <String>[],
            );
        expect(shown, isEmpty);
      },
    );

    test('B\'s mute read failed: A\'s mute is not shown, and a toggle is '
        'refused rather than computed from A\'s set', () async {
      await container.read(sessionUserProvider.future);
      expect(await container.read(conversationMutesProvider.future), {
        'conversation-of-a',
      });
      await switchTo(null);
      _bFails = true;
      await switchTo('account-b');
      container.listen(conversationMutesProvider, (_, _) {});
      await pumpEventQueue();

      // What the conversation screen reads.
      expect(container.read(conversationMutesProvider).asData, isNull);
      await expectLater(
        container
            .read(conversationMutesProvider.notifier)
            .setMuted('conversation-of-b', true),
        throwsA(isA<NotificationsException>()),
      );
      expect(mutes.muted, isEmpty);
    });
  });
}

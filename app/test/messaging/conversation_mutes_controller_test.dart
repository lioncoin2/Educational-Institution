import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/notifications.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/messaging/state/conversation_mutes_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// Conversation PUSH mute (Q6 / ADR 0036). The controller loads the viewer's
/// muted set, flips one conversation optimistically through the repository, and
/// rolls back if the server refuses. These tests pin that contract; the
/// repository is a fake (no real backend).
class _FakeNotifications implements NotificationsRepository {
  _FakeNotifications({Set<String> initial = const {}, this.failMute = false})
    : _muted = {...initial};

  final Set<String> _muted;
  final bool failMute;
  final List<String> muteCalls = [];
  final List<String> unmuteCalls = [];

  @override
  Future<Set<String>> mutedConversations() async => Set.of(_muted);

  @override
  Future<void> muteConversation(String conversationId) async {
    muteCalls.add(conversationId);
    if (failMute) {
      throw const NotificationsException('network.unreachable', 'offline');
    }
    _muted.add(conversationId);
  }

  @override
  Future<void> unmuteConversation(String conversationId) async {
    unmuteCalls.add(conversationId);
    _muted.remove(conversationId);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

ProviderContainer _container(_FakeNotifications fake) {
  final container = ProviderContainer(
    overrides: [notificationsRepositoryProvider.overrideWithValue(fake)],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  test('loads the viewer\'s muted set', () async {
    final container = _container(_FakeNotifications(initial: {'c-pre'}));
    final set = await container.read(conversationMutesProvider.future);
    expect(set, {'c-pre'});
  });

  test('mutes a conversation optimistically and persists it', () async {
    final fake = _FakeNotifications(initial: {'c-pre'});
    final container = _container(fake);
    await container.read(conversationMutesProvider.future);

    await container
        .read(conversationMutesProvider.notifier)
        .setMuted('c1', true);

    expect(fake.muteCalls, ['c1']);
    expect(container.read(conversationMutesProvider).value, {'c-pre', 'c1'});
  });

  test('unmutes a conversation', () async {
    final fake = _FakeNotifications(initial: {'c1'});
    final container = _container(fake);
    await container.read(conversationMutesProvider.future);

    await container
        .read(conversationMutesProvider.notifier)
        .setMuted('c1', false);

    expect(fake.unmuteCalls, ['c1']);
    expect(container.read(conversationMutesProvider).value, isEmpty);
  });

  test('reverts and rethrows when the server refuses', () async {
    final fake = _FakeNotifications(failMute: true);
    final container = _container(fake);
    await container.read(conversationMutesProvider.future);

    await expectLater(
      container.read(conversationMutesProvider.notifier).setMuted('c1', true),
      throwsA(isA<NotificationsException>()),
    );
    // Optimistic add was rolled back — the UI never shows an unaccepted state.
    expect(container.read(conversationMutesProvider).value, isEmpty);
  });
}

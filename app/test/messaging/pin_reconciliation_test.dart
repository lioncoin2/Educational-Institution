import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/features/messaging/state/conversation_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../realtime/fake_realtime_client.dart';

/// The pin-state reconciliation rules (ADR 0043 §realtime), tested at the
/// controller/state layer without widgets. The single ordering rule is: a pin
/// change — event OR refresh — is accepted only when its `pinVersion` is
/// strictly newer than the held state's. Timestamps never decide.
class ReconcileRepo extends MockMessagingRepository {
  ReconcileRepo() : super(latency: Duration.zero);

  /// The next `conversation()` read returns this instead of the real one —
  /// a controlled refresh snapshot (newer or staler). Consumed once.
  Conversation? nextRefresh;
  bool failNextLocal = false;

  @override
  Future<Conversation> conversation(String id) async {
    final real = await super.conversation(id);
    final override = nextRefresh;
    nextRefresh = null;
    return override ?? real;
  }

  @override
  Future<void> pinMessage(String conversationId, String messageId) async {
    if (failNextLocal) {
      failNextLocal = false;
      throw const MessagingException('network.unreachable', 'offline');
    }
    return super.pinMessage(conversationId, messageId);
  }

  @override
  Future<void> unpinMessage(String conversationId) async {
    if (failNextLocal) {
      failNextLocal = false;
      throw const MessagingException('network.unreachable', 'offline');
    }
    return super.unpinMessage(conversationId);
  }
}

void main() {
  const ownedChat = '${MockCommunityRepository.ownedId}-chat';
  const pinnedId = '${MockCommunityRepository.ownedId}-chat-m1';

  late ReconcileRepo repo;
  late FakeRealtimeClient realtime;
  late ProviderContainer container;

  setUp(() {
    repo = ReconcileRepo();
    realtime = FakeRealtimeClient();
    container = ProviderContainer(
      overrides: [
        messagingRepositoryProvider.overrideWithValue(repo),
        realtimeConnectionProvider.overrideWithValue(realtime),
      ],
    );
    container.listen(conversationProvider(ownedChat), (_, _) {});
  });
  tearDown(() => container.dispose());

  Future<ConversationState> load() =>
      container.read(conversationProvider(ownedChat).future);
  ConversationController controller() =>
      container.read(conversationProvider(ownedChat).notifier);
  ConversationState now() =>
      container.read(conversationProvider(ownedChat)).requireValue;

  // The event stream is synchronous; refreshes are async, so flush microtasks.
  Future<void> pump() async {
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
  }

  MessagePinnedEvent ev(String? id, int version) => MessagePinnedEvent(
    eventId: 'message.pinned:$version',
    occurredAt: DateTime(2026, 1, 1, 9),
    conversationId: ownedChat,
    pinnedMessageId: id,
    pinVersion: version,
  );

  test('a newer event wins; an older event never regresses it', () async {
    await load();
    realtime.emit(ev(pinnedId, 5));
    expect(now().conversation.pinnedMessageId, pinnedId);
    expect(now().conversation.pinVersion, 5);
    // An older unpin (version 3) arriving late must NOT clear the newer pin.
    realtime.emit(ev(null, 3));
    expect(now().conversation.pinnedMessageId, pinnedId);
    expect(now().conversation.pinVersion, 5);
  });

  test('a duplicate event (same version) is idempotent', () async {
    await load();
    realtime.emit(ev(pinnedId, 4));
    realtime.emit(ev(pinnedId, 4));
    realtime.emit(ev(pinnedId, 4));
    expect(now().conversation.pinnedMessageId, pinnedId);
    expect(now().conversation.pinVersion, 4);
  });

  test('a stale refresh cannot overwrite a newer event', () async {
    final base = await load();
    realtime.emit(ev(pinnedId, 5));
    // A reconnect refresh reflecting an OLDER snapshot (unpinned at version 3).
    repo.nextRefresh = base.conversation.withPin(null, 3);
    realtime.setStatus(RealtimeStatus.reconnected);
    await pump();
    // The newer event's pin is preserved; the stale snapshot is ignored for it.
    expect(now().conversation.pinnedMessageId, pinnedId);
    expect(now().conversation.pinVersion, 5);
  });

  test('a reconnect refresh with a NEWER snapshot wins', () async {
    final base = await load();
    realtime.emit(ev(pinnedId, 2));
    // The server moved on while away: unpinned at a newer version 7.
    repo.nextRefresh = base.conversation.withPin(null, 7);
    realtime.setStatus(RealtimeStatus.reconnected);
    await pump();
    expect(now().conversation.pinnedMessageId, isNull);
    expect(now().conversation.pinVersion, 7);
  });

  test('a local unpin whose refresh is stale cannot regress a newer pin', () async {
    final base = await load();
    realtime.emit(ev(pinnedId, 8)); // a newer remote pin
    repo.nextRefresh = base.conversation.withPin(null, 5); // the local op's stale refresh
    await controller().unpinMessage();
    await pump();
    expect(now().conversation.pinnedMessageId, pinnedId);
    expect(now().conversation.pinVersion, 8);
  });

  test('a failed local op does not erase a successful remote change', () async {
    await load();
    realtime.emit(ev(pinnedId, 6)); // a remote pin
    repo.failNextLocal = true;
    await expectLater(
      controller().unpinMessage(),
      throwsA(isA<MessagingException>()),
    );
    await pump();
    // The failed local unpin never ran a refresh; the remote pin stands.
    expect(now().conversation.pinnedMessageId, pinnedId);
    expect(now().conversation.pinVersion, 6);
  });

  test('pin state is isolated per conversation', () async {
    await load();
    realtime.emit(ev(pinnedId, 5));
    // An event for ANOTHER conversation is ignored by this controller.
    realtime.emit(
      MessagePinnedEvent(
        eventId: 'message.pinned:other',
        occurredAt: DateTime(2026, 1, 1, 10),
        conversationId: 'another-chat',
        pinnedMessageId: null,
        pinVersion: 99,
      ),
    );
    expect(now().conversation.pinnedMessageId, pinnedId);
    expect(now().conversation.pinVersion, 5);
  });
}

import '../../../app/app_config.dart';
import '../../models/live.dart';
import '../../models/live_chat.dart';
import '../repositories.dart';

/// The demo's live chat: one in-memory chat per session, the viewer its
/// moderator (as the demo viewer hosts the demo session). Nothing leaves the
/// device; the lock behaves as the server's does.
class MockLiveChatRepository implements LiveChatRepository {
  MockLiveChatRepository({this.latency = AppConfig.fakeLatency});

  final Duration latency;
  static const String viewer = 'mock-student';

  final Map<String, List<LiveChatMessage>> _chats = {};
  final Map<String, LiveChatLockState> _locks = {};
  final Map<String, LiveChatMessage> _byKey = {};
  int _position = 0;

  Future<void> _wait() => Future<void>.delayed(latency);

  List<LiveChatMessage> _chat(String sessionId) => _chats.putIfAbsent(
    sessionId,
    () => [
      LiveChatMessage(
        id: 'mock-chat-$sessionId-1',
        sessionId: sessionId,
        senderId: 'mock-teacher',
        senderDisplayName: 'الأستاذ أحمد',
        body: 'أهلًا بكم في البث، اكتبوا أسئلتكم هنا.',
        createdAt: DateTime.now().toUtc().subtract(const Duration(minutes: 3)),
        position: ++_position,
      ),
    ],
  );

  LiveChatLockState _lock(String sessionId) =>
      _locks[sessionId] ??
      const LiveChatLockState(locked: false, lockVersion: 0);

  @override
  Future<LiveChatPage> page(String sessionId, {String? before}) async {
    await _wait();
    final limit = 50;
    final cut = before == null ? null : int.tryParse(before);
    final older = _chat(sessionId).reversed
        .where((m) => cut == null || m.position < cut)
        .toList();
    final items = older.take(limit).toList();
    final lock = _lock(sessionId);
    return LiveChatPage(
      items: items,
      nextCursor: older.length > limit ? '${items.last.position}' : null,
      locked: lock.locked,
      lockVersion: lock.lockVersion,
      canPost: true,
      canModerate: true,
    );
  }

  @override
  Future<LiveChatMessage> post(
    String sessionId, {
    required String clientMessageId,
    required String body,
  }) async {
    await _wait();
    final text = body.trim();
    if (text.isEmpty) {
      throw const LiveException(
        'live.chat_body_required',
        'A chat message needs text.',
      );
    }
    final key = '$sessionId/$clientMessageId';
    final existing = _byKey[key];
    if (existing != null) return existing;
    final message = LiveChatMessage(
      id: 'mock-chat-$sessionId-${_position + 1}',
      sessionId: sessionId,
      senderId: viewer,
      senderDisplayName: 'أنت',
      body: text,
      createdAt: DateTime.now().toUtc(),
      position: ++_position,
    );
    _chat(sessionId).add(message);
    _byKey[key] = message;
    return message;
  }

  @override
  Future<LiveChatLockState> setLocked(
    String sessionId, {
    required bool locked,
  }) async {
    await _wait();
    final current = _lock(sessionId);
    if (current.locked == locked) return current;
    return _locks[sessionId] = LiveChatLockState(
      locked: locked,
      lockVersion: current.lockVersion + 1,
    );
  }
}

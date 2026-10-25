import '../../api/api_client.dart';
import '../../models/live.dart';
import '../../models/live_chat.dart';
import '../repositories.dart';

/// [LiveChatRepository] against the real backend (`/live/sessions/:id/chat`).
/// Every transport and parsing failure becomes a [LiveException] keeping the
/// server's code.
class HttpLiveChatRepository implements LiveChatRepository {
  HttpLiveChatRepository(this._api);

  final ApiClient _api;

  String _chat(String sessionId) =>
      '/live/sessions/${Uri.encodeComponent(sessionId)}/chat';

  @override
  Future<LiveChatPage> page(String sessionId, {String? before}) =>
      _call(() async {
        final json = await _api.get(
          _chat(sessionId),
          query: before == null ? null : {'before': before},
        );
        return LiveChatPage.fromJson(json);
      });

  @override
  Future<LiveChatMessage> post(
    String sessionId, {
    required String clientMessageId,
    required String body,
  }) => _call(() async {
    final json = await _api.post(
      _chat(sessionId),
      body: {'clientMessageId': clientMessageId, 'body': body},
    );
    return LiveChatMessage.fromJson(json);
  });

  @override
  Future<LiveChatLockState> setLocked(
    String sessionId, {
    required bool locked,
  }) => _call(() async {
    final path = '${_chat(sessionId)}/lock';
    final json = locked ? await _api.put(path) : await _api.delete(path);
    return LiveChatLockState.fromJson(json);
  });

  static const _unreadable = LiveException(
    'live.unreadable',
    'The server sent something this app cannot read.',
  );

  static Future<T> _call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on ApiException catch (error) {
      throw LiveException(
        error.code,
        error.message,
        details: error.details ?? const {},
      );
    } on FormatException {
      throw _unreadable;
    } on TypeError {
      throw _unreadable;
    }
  }
}

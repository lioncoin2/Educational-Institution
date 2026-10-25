import '../../api/api_client.dart';
import '../../models/live.dart';
import '../../models/live_room.dart';
import '../repositories.dart';

/// [LiveRoomRepository] against the real backend (C15): a participant's picture
/// link (`GET /live/sessions/:id/participants/:userId/avatar`, ADR 0048) and the
/// room's reactions (`POST /live/sessions/:id/reactions`, ADR 0049). Every
/// transport and parsing failure becomes a [LiveException] keeping the server's
/// code — except "no picture", which is the ordinary answer null.
class HttpLiveRoomRepository implements LiveRoomRepository {
  HttpLiveRoomRepository(this._api);

  final ApiClient _api;

  String _session(String sessionId) =>
      '/live/sessions/${Uri.encodeComponent(sessionId)}';

  @override
  Future<Uri?> participantAvatarUrl(String sessionId, String userId) async {
    try {
      final json = await _call(
        () => _api.get(
          '${_session(sessionId)}/participants/'
          '${Uri.encodeComponent(userId)}/avatar',
        ),
      );
      final url = json['url'];
      if (url is! String || url.isEmpty) return null;
      // The link is relative to the API (local storage) or absolute (a CDN).
      return _api.resolve(url);
    } on LiveException catch (error) {
      if (error.code == 'live.participant_avatar_not_found') return null;
      rethrow;
    }
  }

  @override
  Future<void> react(String sessionId, LiveReactionKind kind) async {
    await _call(
      () => _api.post(
        '${_session(sessionId)}/reactions',
        body: {'kind': kind.wire},
      ),
    );
  }

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

import '../../api/api_client.dart';
import '../../models/data_origin.dart';
import '../../models/live.dart';
import '../repositories.dart';

/// [LiveRepository] against the real backend (`/live`).
///
/// Read-only and non-media: it asks for the community's running session and
/// nothing else. No page size is sent; the id goes through
/// [Uri.encodeComponent]. A `{session: null}` answer is "none running now",
/// not an error. Every transport and parsing failure becomes a
/// [LiveException], keeping the server's details.
class HttpLiveRepository implements LiveRepository {
  HttpLiveRepository(this._api);

  final ApiClient _api;

  @override
  Future<LiveSession?> currentSession(String communityId) => _call(() async {
    final json = await _api.get(
      '/live/communities/${Uri.encodeComponent(communityId)}/sessions/current',
    );
    final session = json['session'];
    if (session is! Map) return null;
    return LiveSession.fromJson(
      session.cast<String, Object?>(),
      origin: DataOrigin.records,
    );
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

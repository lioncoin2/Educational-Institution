import '../../api/api_client.dart';
import '../../models/data_origin.dart';
import '../../models/live.dart';
import '../../models/live_media.dart';
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

  @override
  Future<LiveSession> start(String communityId) => _call(() async {
    // Bodyless POST; 201 (new) and 200 (already running) both carry the
    // session, and a 503 `live.media_unavailable` or a refusal flows through
    // [_call] as a [LiveException] with the server's code.
    final json = await _api.post(
      '/live/communities/${Uri.encodeComponent(communityId)}/sessions',
    );
    return LiveSession.fromJson(json, origin: DataOrigin.records);
  });

  @override
  Future<LiveSession> getSession(String sessionId) => _call(() async {
    final json = await _api.get(
      '/live/sessions/${Uri.encodeComponent(sessionId)}',
    );
    return LiveSession.fromJson(json, origin: DataOrigin.records);
  });

  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) => _call(() async {
    final json = await _api.get(
      '/live/sessions/${Uri.encodeComponent(sessionId)}/hands',
      query: {
        'state': ?state?.wire,
        'cursor': ?cursor,
        'limit': ?limit?.toString(),
      },
    );
    return LiveHandsPage.fromJson(json, origin: DataOrigin.records);
  });

  // ── Moderator commands ─────────────────────────────────────────────────
  // Bodyless POST/DELETE to the exact routes; the server is the sole
  // authority, and the session read (via realtime reconciliation) is the
  // state. These return the server's answer, never an optimistic guess.

  @override
  Future<LiveSession> endSession(String sessionId) => _call(() async {
    final json = await _api.post(
      '/live/sessions/${Uri.encodeComponent(sessionId)}/end',
    );
    return LiveSession.fromJson(json, origin: DataOrigin.records);
  });

  @override
  Future<bool> removeParticipant(
    String sessionId,
    String userId, {
    String? reason,
  }) => _call(() async {
    final path =
        '/live/sessions/${Uri.encodeComponent(sessionId)}'
        '/participants/${Uri.encodeComponent(userId)}/remove';
    final json = await _api.post(
      reason == null
          ? path
          : '$path?reason=${Uri.encodeQueryComponent(reason)}',
    );
    return json['removed'] == true;
  });

  @override
  Future<bool> resetRoom(String sessionId) => _call(() async {
    final json = await _api.post(
      '/live/sessions/${Uri.encodeComponent(sessionId)}/reset',
    );
    return json['reset'] == true;
  });

  @override
  Future<LiveSession> claimPresenter(String sessionId) => _call(() async {
    final json = await _api.post(
      '/live/sessions/${Uri.encodeComponent(sessionId)}/screen-share',
    );
    return LiveSession.fromJson(json, origin: DataOrigin.records);
  });

  @override
  Future<LiveSession> stopPresenter(String sessionId) => _call(() async {
    final json = await _api.delete(
      '/live/sessions/${Uri.encodeComponent(sessionId)}/screen-share',
    );
    return LiveSession.fromJson(json, origin: DataOrigin.records);
  });

  @override
  Future<LiveSession> grantPresenter(String sessionId, String userId) =>
      _call(() async {
        final json = await _api.post(
          '/live/sessions/${Uri.encodeComponent(sessionId)}'
          '/screen-share/${Uri.encodeComponent(userId)}/grant',
        );
        return LiveSession.fromJson(json, origin: DataOrigin.records);
      });

  @override
  Future<LiveSession> revokePresenter(String sessionId, String userId) =>
      _call(() async {
        final json = await _api.delete(
          '/live/sessions/${Uri.encodeComponent(sessionId)}'
          '/screen-share/${Uri.encodeComponent(userId)}',
        );
        return LiveSession.fromJson(json, origin: DataOrigin.records);
      });

  // ── Speaking: the floor (raise a hand, and moderate it) ─────────────────
  // Bodyless POST/DELETE to the exact routes. Each returns a `{request}`
  // envelope (grant/revoke also carry a media outcome, which this non-media
  // build ignores); the request is parsed as a [LiveHand]. The authoritative
  // `me.hand` and the queue arrive through the session read and the hands
  // re-read, never from a command's own result.

  @override
  Future<LiveHand> raiseHand(String sessionId) => _call(() async {
    final json = await _api.post(
      '/live/sessions/${Uri.encodeComponent(sessionId)}/hand',
    );
    return _request(json);
  });

  @override
  Future<LiveHand?> lowerHand(String sessionId) => _call(() async {
    final json = await _api.delete(
      '/live/sessions/${Uri.encodeComponent(sessionId)}/hand',
    );
    return _requestOrNull(json);
  });

  @override
  Future<LiveHand> grantFloor(String requestId) => _call(() async {
    final json = await _api.post(
      '/live/requests/${Uri.encodeComponent(requestId)}/grant',
    );
    return _request(json);
  });

  @override
  Future<LiveHand> declineHand(String requestId) => _call(() async {
    final json = await _api.post(
      '/live/requests/${Uri.encodeComponent(requestId)}/decline',
    );
    return _request(json);
  });

  @override
  Future<LiveHand> revokeFloor(String requestId) => _call(() async {
    final json = await _api.post(
      '/live/requests/${Uri.encodeComponent(requestId)}/revoke',
    );
    return _request(json);
  });

  /// The `request` of a floor envelope, as a [LiveHand]. A missing or malformed
  /// request is a [FormatException] (→ `live.unreadable` through [_call]).
  static LiveHand _request(Map<String, Object?> json) {
    final request = json['request'];
    if (request is! Map) {
      throw const FormatException('live: missing "request"');
    }
    return LiveHand.fromJson(request.cast<String, Object?>());
  }

  /// The `request` of a floor envelope when present, or null (`{request: null}`
  /// — the caller had no hand up to lower).
  static LiveHand? _requestOrNull(Map<String, Object?> json) {
    final request = json['request'];
    if (request is! Map) return null;
    return LiveHand.fromJson(request.cast<String, Object?>());
  }

  // ── Media ──────────────────────────────────────────────────────────────

  @override
  Future<LiveMediaGrant> join(String sessionId) => _call(() async {
    final json = await _api.post(
      '/live/sessions/${Uri.encodeComponent(sessionId)}/join',
    );
    return LiveMediaGrant.fromJson(json);
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

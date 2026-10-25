import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'refresh_lock.dart';
import 'token_store.dart';

/// A refusal from the API, carrying its stable error code
/// (`messaging.conversation_not_found`, `files.too_large`, …).
///
/// [status] is 0 when the server was never reached.
class ApiException implements Exception {
  const ApiException({
    required this.status,
    required this.code,
    required this.message,
    this.details,
  });

  final int status;
  final String code;
  final String message;
  final Map<String, Object?>? details;

  bool get isUnreachable => status == 0;
  bool get isUnauthenticated => status == 401;

  @override
  String toString() => 'ApiException($status, $code): $message';
}

/// The one door to the backend.
///
/// Screens never see it; repositories do. It adds the bearer token, maps
/// every error to [ApiException], and renews an expired access token with
/// ONE refresh at a time: the server rotates refresh tokens and treats a
/// token presented twice as stolen, so two concurrent refreshes would sign
/// the user out on purpose. Callers that hit an expired token together all
/// wait on the same refresh.
class ApiClient {
  ApiClient({
    required Uri baseUri,
    required http.Client httpClient,
    required TokenStore tokenStore,
    this.onSignedOut,
    RefreshLock refreshLock = const InProcessRefreshLock(),
  }) : _base = baseUri,
       _http = httpClient,
       _tokens = tokenStore,
       _sharedRefresh = refreshLock;

  final Uri _base;
  final http.Client _http;
  final TokenStore _tokens;

  /// Holds the refresh to one app instance at a time when several share the
  /// stored tokens (browser tabs) — see [RefreshLock].
  final RefreshLock _sharedRefresh;

  /// Called when the session is gone for good (refresh refused).
  final void Function()? onSignedOut;

  Future<_Refresh>? _refreshing;

  TokenStore get tokens => _tokens;

  /// The access token for a connection that is not an HTTP request — the
  /// realtime socket — renewed first when [renew] is set.
  ///
  /// Renewal is the same single-flight refresh every request uses, so a
  /// socket and an HTTP call that need a new token at once share one
  /// refresh rather than racing (the server would take the second for a
  /// stolen token). Null when nobody is signed in, or when the renewal was
  /// refused — the session is over, and [onSignedOut] runs as it would for
  /// a request. Throws [ApiException] when the server could not be reached.
  Future<String?> accessToken({bool renew = false}) async {
    final tokens = await _tokens.read();
    if (tokens == null) return null;
    if (!renew) return tokens.accessToken;
    switch (await _refresh(tokens)) {
      case _Refresh.renewed:
        return (await _tokens.read())?.accessToken;
      case _Refresh.refused:
        onSignedOut?.call();
        return null;
      case _Refresh.unreachable:
        throw _unreachable();
    }
  }

  /// A path relative to the API, or an absolute URL (object storage), as a URI.
  Uri resolve(String pathOrUrl, [Map<String, String>? query]) {
    final uri = _base.resolve(
      pathOrUrl.startsWith('/') ? pathOrUrl.substring(1) : pathOrUrl,
    );
    return query == null || query.isEmpty
        ? uri
        : uri.replace(queryParameters: {...uri.queryParameters, ...query});
  }

  Future<Map<String, Object?>> get(String path, {Map<String, String>? query}) =>
      _json('GET', path, query: query);

  /// Without a [body], nothing is sent — no content type either: the routes
  /// that take none refuse unknown keys, and an empty request has none.
  Future<Map<String, Object?>> post(
    String path, {
    Object? body,
    bool authenticated = true,
  }) => _json('POST', path, body: body, authenticated: authenticated);

  Future<Map<String, Object?>> put(String path, {Object? body}) =>
      _json('PUT', path, body: body);

  Future<Map<String, Object?>> patch(String path, {Object? body}) =>
      _json('PATCH', path, body: body);

  Future<Map<String, Object?>> delete(String path) => _json('DELETE', path);

  /// PUTs raw bytes to a signed upload URL. No bearer token: the URL's
  /// signature is the authorization, and a token must never travel to what
  /// may be a third-party object store.
  Future<int> putBytes(
    Uri url,
    List<int> bytes,
    Map<String, String> headers,
  ) async {
    final http.Response response;
    try {
      response = await _http.put(url, headers: headers, body: bytes);
    } on Exception {
      throw _unreachable();
    }
    if (response.statusCode >= 400 && response.statusCode != 409) {
      throw _failure(response);
    }
    return response.statusCode;
  }

  Future<Map<String, Object?>> _json(
    String method,
    String path, {
    Object? body,
    Map<String, String>? query,
    bool authenticated = true,
  }) async {
    final url = resolve(path, query);
    var tokens = authenticated ? await _tokens.read() : null;
    if (authenticated && tokens == null) {
      throw const ApiException(
        status: 401,
        code: 'identity.authentication_required',
        message: 'Authentication required.',
      );
    }

    var response = await _send(method, url, body, tokens);
    if (response.statusCode == 401 && tokens != null) {
      switch (await _refresh(tokens)) {
        case _Refresh.renewed:
          tokens = await _tokens.read();
          response = await _send(method, url, body, tokens);
        case _Refresh.refused:
          onSignedOut?.call();
        case _Refresh.unreachable:
          // A network blip is not a sign-out: keep the tokens, report it.
          throw _unreachable();
      }
    }
    if (response.statusCode >= 400) throw _failure(response);
    if (response.body.isEmpty) return const {};
    return (jsonDecode(response.body) as Map).cast<String, Object?>();
  }

  Future<http.Response> _send(
    String method,
    Uri url,
    Object? body,
    Tokens? tokens,
  ) async {
    final request = http.Request(method, url);
    if (tokens != null) {
      request.headers['authorization'] = 'Bearer ${tokens.accessToken}';
    }
    if (body != null) {
      request.headers['content-type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    try {
      return await http.Response.fromStream(await _http.send(request));
    } on Exception {
      throw _unreachable();
    }
  }

  /// Single-flight: whoever arrives while a refresh is running joins it.
  Future<_Refresh> _refresh(Tokens used) {
    return _refreshing ??= _doRefresh(used)
        .whenComplete(() => _refreshing = null);
  }

  Future<_Refresh> _doRefresh(Tokens used) => _sharedRefresh.run(() async {
    // Read under the lock: another instance sharing these tokens (another
    // tab) may have renewed them while this one waited.
    final current = await _tokens.read();
    if (current == null) return _Refresh.refused;
    // Someone else already renewed while this request was in flight.
    if (current.accessToken != used.accessToken) return _Refresh.renewed;
    final http.Response response;
    try {
      response = await _send('POST', resolve('/auth/refresh'), {
        'refreshToken': current.refreshToken,
      }, null);
    } on ApiException {
      return _Refresh.unreachable;
    }
    if (response.statusCode != 200) {
      // An outage, a gateway error or the rate limit says nothing about the
      // session: keep the tokens and report the server as unreachable, as a
      // network blip is.
      if (!_isRefusal(response.statusCode)) return _Refresh.unreachable;
      // Expired, revoked, presented twice, or the account is no longer
      // active: the session is over.
      await _tokens.clear();
      return _Refresh.refused;
    }
    final json = (jsonDecode(response.body) as Map).cast<String, Object?>();
    await _tokens.write(
      Tokens(
        accessToken: json['accessToken']! as String,
        refreshToken: json['refreshToken']! as String,
      ),
    );
    return _Refresh.renewed;
  });

  /// The refresh answers that mean the session itself cannot go on: an
  /// invalid/expired/reused token (401), an inactive account (403), or a
  /// request the server could not accept at all (400/422). Anything else — 408,
  /// 429, a 5xx or a proxy's error page — is the server being unavailable.
  static bool _isRefusal(int status) =>
      status == 400 || status == 401 || status == 403 || status == 422;

  static ApiException _failure(http.Response response) {
    try {
      final json = (jsonDecode(response.body) as Map).cast<String, Object?>();
      final error = (json['error'] as Map?)?.cast<String, Object?>();
      if (error != null) {
        return ApiException(
          status: response.statusCode,
          code: error['code'] as String? ?? 'request_failed',
          message: error['message'] as String? ?? 'Request failed.',
          details: (error['details'] as Map?)?.cast<String, Object?>(),
        );
      }
    } on FormatException {
      // Not our error shape — a proxy or an object store answered.
    }
    return ApiException(
      status: response.statusCode,
      code: 'request_failed',
      message: 'Request failed (${response.statusCode}).',
    );
  }

  static ApiException _unreachable() => const ApiException(
    status: 0,
    code: 'network.unreachable',
    message: 'The server could not be reached.',
  );
}

enum _Refresh { renewed, refused, unreachable }

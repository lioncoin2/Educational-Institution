import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:web_socket/web_socket.dart';

import 'realtime_client.dart';
import 'realtime_frames.dart';

/// The access token to authenticate with — renewed first when [renew] is
/// set. Null when nobody is signed in any more. Throws when the server
/// could not be reached to renew it.
typedef AccessTokenSource = Future<String?> Function({bool renew});

/// Opens a WebSocket. Injected so tests can hand the client a fake one.
typedef WebSocketConnector = Future<WebSocket> Function(Uri url);

/// Every delay the client uses, in one place — tests shrink them.
class RealtimeTiming {
  const RealtimeTiming({
    this.handshakeTimeout = const Duration(seconds: 10),
    this.heartbeatInterval = const Duration(seconds: 25),
    this.pongTimeout = const Duration(seconds: 10),
    this.renewBeforeExpiry = const Duration(seconds: 60),
    this.minimumRenewalDelay = const Duration(seconds: 30),
    this.subscribeTimeout = const Duration(seconds: 10),
    this.backoffBase = const Duration(seconds: 1),
    this.backoffMax = const Duration(seconds: 30),
  });

  /// How long an open socket may take to say `ready`.
  final Duration handshakeTimeout;

  /// How often the client pings. It must hear something back within
  /// [pongTimeout], or it treats the connection as dead — the only way to
  /// notice a network that vanished without closing anything (a phone
  /// switching from Wi-Fi to cellular, a laptop waking up).
  final Duration heartbeatInterval;
  final Duration pongTimeout;

  /// Re-authenticate this long before the access token expires.
  final Duration renewBeforeExpiry;

  /// Never renew more often than this, whatever a skewed clock suggests.
  final Duration minimumRenewalDelay;

  final Duration subscribeTimeout;

  /// Reconnect backoff: doubling from [backoffBase] to [backoffMax], with
  /// jitter, so a classroom that lost its network together does not return
  /// in one burst.
  final Duration backoffBase;
  final Duration backoffMax;
}

/// `https://api.example.org/` → `wss://api.example.org/realtime`.
Uri realtimeEndpoint(Uri apiBase) {
  final path = apiBase.path.endsWith('/') ? apiBase.path : '${apiBase.path}/';
  return Uri(
    scheme: apiBase.scheme == 'https' ? 'wss' : 'ws',
    host: apiBase.host,
    port: apiBase.hasPort ? apiBase.port : null,
    path: '${path}realtime',
  );
}

/// [RealtimeClient] over a WebSocket (`package:web_socket` — the browser's
/// own WebSocket on the web, `dart:io`'s elsewhere).
///
/// It authenticates with the access token in the first frame — never in the
/// URL — and again with a fresh token before the old one expires. It
/// reconnects with backoff when the connection drops, reports
/// `reconnected` so the state layer catches up over HTTP, and drops a
/// repeated event by its id. What an event means is not its business.
class WebSocketRealtimeClient implements RealtimeClient {
  WebSocketRealtimeClient({
    required this._endpoint,
    required this._accessToken,
    WebSocketConnector? connector,
    this.timing = const RealtimeTiming(),
    Random? random,
  }) : _connector = connector ?? WebSocket.connect,
       _random = random ?? Random();

  final Uri _endpoint;
  final AccessTokenSource _accessToken;
  final WebSocketConnector _connector;
  final Random _random;
  final RealtimeTiming timing;

  final _statuses = StreamController<RealtimeStatus>.broadcast();
  final _events = StreamController<RealtimeEvent>.broadcast();

  /// Recently delivered event ids: the same fact twice is passed on once.
  final _recentEvents = <String>{};
  static const int _recentEventLimit = 512;

  final _awaiting = <String, Completer<SubscriptionResult>>{};

  RealtimeStatus _status = RealtimeStatus.disconnected;
  bool _wanted = false;
  bool _everLive = false;
  bool _renewNext = false;
  bool _opening = false;
  int _failures = 0;
  int _requests = 0;
  Timer? _retry;
  _Session? _session;

  @override
  bool get isAvailable => true;

  @override
  RealtimeStatus get status => _status;

  @override
  Stream<RealtimeStatus> get statuses => _statuses.stream;

  @override
  Stream<RealtimeEvent> get events => _events.stream;

  @override
  Future<void> connect() async {
    if (_wanted) return;
    _wanted = true;
    await _open();
  }

  @override
  Future<void> disconnect() async {
    _wanted = false;
    _retry?.cancel();
    _retry = null;
    _drop();
    _failures = 0;
    _everLive = false;
    _renewNext = false;
    _setStatus(RealtimeStatus.disconnected);
  }

  @override
  Future<void> reconnect() async {
    if (!_wanted) return connect();
    _retry?.cancel();
    _drop();
    _failures = 0;
    await _open();
  }

  @override
  Future<SubscriptionResult> subscribe(String conversationId) {
    final session = _session;
    if (session == null || !session.ready) {
      return Future.value(const SubscriptionUnavailable());
    }
    _requests += 1;
    final id = 's$_requests';
    final answer = Completer<SubscriptionResult>();
    _awaiting[id] = answer;
    _send(session, {
      'type': 'subscribe',
      'conversationId': conversationId,
      'id': id,
    });
    return answer.future.timeout(
      timing.subscribeTimeout,
      onTimeout: () {
        _awaiting.remove(id);
        return const SubscriptionUnavailable();
      },
    );
  }

  @override
  Future<void> dispose() async {
    await disconnect();
    await _statuses.close();
    await _events.close();
  }

  // ── Opening ──────────────────────────────────────────────────────────

  Future<void> _open() async {
    _retry?.cancel();
    _retry = null;
    if (!_wanted || _session != null || _opening) return;
    _opening = true;
    try {
      _setStatus(
        _everLive ? RealtimeStatus.reconnecting : RealtimeStatus.connecting,
      );
      final String? token;
      try {
        token = await _accessToken(renew: _renewNext);
      } on Object {
        // The server could not be reached to renew: try again later.
        _scheduleRetry();
        return;
      }
      if (!_wanted) return;
      if (token == null) {
        // Nobody is signed in any more.
        _stop();
        return;
      }
      _renewNext = false;

      final WebSocket socket;
      try {
        socket = await _connector(_endpoint);
      } on Object {
        _scheduleRetry();
        return;
      }
      if (!_wanted) {
        _closeQuietly(socket);
        return;
      }
      final session = _Session(socket);
      _session = session;
      session.subscription = socket.events.listen(
        (event) => _onSocketEvent(session, event),
        onDone: () => _onClosed(session, null),
      );
      session.handshake = Timer(
        timing.handshakeTimeout,
        () => _onClosed(session, null),
      );
      _send(session, {'type': 'auth', 'token': token});
    } finally {
      _opening = false;
    }
  }

  // ── Frames ───────────────────────────────────────────────────────────

  void _onSocketEvent(_Session session, WebSocketEvent event) {
    if (!identical(_session, session)) return;
    switch (event) {
      case TextDataReceived(:final text):
        _onText(session, text);
      case BinaryDataReceived():
        break; // Not part of the protocol.
      case CloseReceived(:final code):
        _onClosed(session, code);
    }
  }

  void _onText(_Session session, String text) {
    session.heardFrom();
    final frame = ServerFrame.parse(text);
    switch (frame) {
      case null:
        return; // Malformed, or from a newer protocol: never half-applied.
      case ReadyFrame():
        _onReady(session, frame);
      case SubscribedFrame():
        _answer(
          frame.id,
          Subscribed(
            lastSequence: frame.lastSequence,
            lastReadSequence: frame.lastReadSequence,
          ),
        );
      case PongFrame():
        return;
      case ErrorFrame():
        if (frame.id != null && _awaiting.containsKey(frame.id)) {
          _answer(frame.id, SubscriptionRefused(frame.code));
        } else {
          // Explains the close that usually follows.
          session.lastError = frame;
        }
      case RealtimeEvent():
        if (_recentEvents.contains(frame.eventId)) return;
        _recentEvents.add(frame.eventId);
        if (_recentEvents.length > _recentEventLimit) {
          _recentEvents.remove(_recentEvents.first);
        }
        _events.add(frame);
    }
  }

  void _onReady(_Session session, ReadyFrame ready) {
    session.handshake?.cancel();
    _failures = 0;
    if (!session.ready) {
      session.ready = true;
      _setStatus(
        _everLive ? RealtimeStatus.reconnected : RealtimeStatus.connected,
      );
      _everLive = true;
      session.heartbeat = Timer.periodic(
        timing.heartbeatInterval,
        (_) => _ping(session),
      );
    }
    // Re-authenticate before the token expires — the server closes the
    // connection at expiry otherwise.
    session.renewal?.cancel();
    var lead =
        ready.expiresAt.difference(DateTime.now()) - timing.renewBeforeExpiry;
    if (lead < timing.minimumRenewalDelay) lead = timing.minimumRenewalDelay;
    session.renewal = Timer(lead, () => unawaited(_renew(session)));
  }

  void _ping(_Session session) {
    _send(session, {'type': 'ping'});
    session.liveness ??= Timer(
      timing.pongTimeout,
      () => _onClosed(session, null),
    );
  }

  Future<void> _renew(_Session session) async {
    final String? token;
    try {
      token = await _accessToken(renew: true);
    } on Object {
      // Unreachable for now: if it stays so, the server closes the
      // connection at expiry and the reconnect path renews.
      return;
    }
    if (!identical(_session, session)) return;
    if (token == null) {
      await disconnect(); // Signed out.
      return;
    }
    _send(session, {'type': 'auth', 'token': token});
  }

  // ── Closing ──────────────────────────────────────────────────────────

  /// The connection ended — closed by the server, lost, or given up on.
  void _onClosed(_Session session, int? code) {
    if (!identical(_session, session)) return;
    _drop();
    if (!_wanted) {
      _setStatus(RealtimeStatus.disconnected);
      return;
    }
    switch (code) {
      case RealtimeCloseCodes.unauthorized:
        // Expired or revoked: renew first. Straight away the first time;
        // with backoff if the server keeps refusing.
        _renewNext = true;
        _scheduleRetry(immediately: _failures == 0);
      case RealtimeCloseCodes.forbidden:
        // This account may not use it; retrying will not change that.
        _stop();
      case RealtimeCloseCodes.rateLimited:
        final wait = session.lastError?.retryAfterSeconds ?? 0;
        _scheduleRetry(atLeast: Duration(seconds: wait));
      default:
        _scheduleRetry();
    }
  }

  void _scheduleRetry({
    bool immediately = false,
    Duration atLeast = Duration.zero,
  }) {
    _setStatus(
      _everLive ? RealtimeStatus.reconnecting : RealtimeStatus.connecting,
    );
    var delay = timing.backoffBase * pow(2, min(_failures, 16));
    if (delay > timing.backoffMax) delay = timing.backoffMax;
    delay = delay * (0.5 + _random.nextDouble() * 0.5);
    if (immediately) delay = Duration.zero;
    if (delay < atLeast) delay = atLeast;
    _failures += 1;
    _retry?.cancel();
    _retry = Timer(delay, () => unawaited(_open()));
  }

  void _stop() {
    _wanted = false;
    _retry?.cancel();
    _retry = null;
    _everLive = false;
    _setStatus(RealtimeStatus.disconnected);
  }

  /// Forgets the current session and closes its socket, if there is one.
  void _drop() {
    final session = _session;
    _session = null;
    for (final answer in _awaiting.values) {
      if (!answer.isCompleted) answer.complete(const SubscriptionUnavailable());
    }
    _awaiting.clear();
    if (session == null) return;
    session.dispose();
    _closeQuietly(session.socket);
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  void _answer(String? id, SubscriptionResult result) {
    final answer = id == null ? null : _awaiting.remove(id);
    if (answer != null && !answer.isCompleted) answer.complete(result);
  }

  void _send(_Session session, Map<String, Object?> frame) {
    try {
      session.socket.sendText(jsonEncode(frame));
    } on WebSocketException {
      // Closed underneath us; the close event follows.
    }
  }

  void _closeQuietly(WebSocket socket) {
    unawaited(Future.sync(() => socket.close(1000)).catchError((Object _) {}));
  }

  void _setStatus(RealtimeStatus next) {
    if (next == _status) return;
    _status = next;
    if (!_statuses.isClosed) _statuses.add(next);
  }
}

/// One socket's worth of bookkeeping.
class _Session {
  _Session(this.socket);

  final WebSocket socket;
  StreamSubscription<WebSocketEvent>? subscription;
  Timer? handshake;
  Timer? heartbeat;
  Timer? liveness;
  Timer? renewal;
  bool ready = false;
  ErrorFrame? lastError;

  /// Anything from the server proves the connection is alive.
  void heardFrom() {
    liveness?.cancel();
    liveness = null;
  }

  void dispose() {
    unawaited(subscription?.cancel());
    handshake?.cancel();
    heartbeat?.cancel();
    liveness?.cancel();
    renewal?.cancel();
  }
}

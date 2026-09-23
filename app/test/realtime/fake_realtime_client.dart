import 'dart:async';

import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/realtime/realtime_frames.dart';

/// A live connection the test drives: it decides the status, the events,
/// and the answer to every subscription.
class FakeRealtimeClient implements RealtimeClient {
  FakeRealtimeClient({this._status = RealtimeStatus.connected});

  final _events = StreamController<RealtimeEvent>.broadcast(sync: true);
  final _statuses = StreamController<RealtimeStatus>.broadcast(sync: true);
  RealtimeStatus _status;

  /// What the server answers to `subscribe` — by default, unavailable.
  SubscriptionResult Function(String conversationId) onSubscribe = (_) =>
      const SubscriptionUnavailable();

  final List<String> subscriptions = [];

  void emit(RealtimeEvent event) => _events.add(event);

  void setStatus(RealtimeStatus status) {
    _status = status;
    _statuses.add(status);
  }

  @override
  bool get isAvailable => true;

  @override
  RealtimeStatus get status => _status;

  @override
  Stream<RealtimeStatus> get statuses => _statuses.stream;

  @override
  Stream<RealtimeEvent> get events => _events.stream;

  @override
  Future<void> connect() async {}

  @override
  Future<void> disconnect() async {}

  @override
  Future<void> reconnect() async {}

  @override
  Future<SubscriptionResult> subscribe(String conversationId) async {
    subscriptions.add(conversationId);
    return onSubscribe(conversationId);
  }

  @override
  Future<void> dispose() async {
    await _events.close();
    await _statuses.close();
  }
}

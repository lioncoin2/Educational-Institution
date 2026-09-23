import 'dart:async';

import 'realtime_frames.dart';

/// Where the live connection stands.
///
///   disconnected   not connected, and not trying (signed out, or refused)
///   connecting     opening the first connection
///   connected      live — the first time
///   reconnecting   the connection dropped; trying again, with backoff
///   reconnected    live again — whatever happened meanwhile must be caught
///                  up over HTTP
enum RealtimeStatus {
  disconnected,
  connecting,
  connected,
  reconnecting,
  reconnected;

  bool get isLive => this == connected || this == reconnected;
}

/// The answer to "follow this conversation".
sealed class SubscriptionResult {
  const SubscriptionResult();
}

/// Confirmed, with the server's positions to catch up from.
final class Subscribed extends SubscriptionResult {
  const Subscribed({
    required this.lastSequence,
    required this.lastReadSequence,
  });

  final int lastSequence;
  final int lastReadSequence;
}

/// Refused — for a conversation, `code.meansNoAccess` says the person is
/// not (or no longer) a member.
final class SubscriptionRefused extends SubscriptionResult {
  const SubscriptionRefused(this.code);

  final RealtimeErrorCode code;
}

/// No live connection to ask over. HTTP still works.
final class SubscriptionUnavailable extends SubscriptionResult {
  const SubscriptionUnavailable();
}

/// The live connection to the backend, as the app's state sees it.
///
/// Nothing above this interface knows it is a WebSocket. It delivers
/// events and connection states; the messaging state decides what they
/// mean. It is never the source of truth: whatever it misses, the state
/// recovers over HTTP by sequence.
abstract interface class RealtimeClient {
  /// False where there is no backend to connect to (the demo build).
  bool get isAvailable;

  RealtimeStatus get status;

  /// Every change of [status].
  Stream<RealtimeStatus> get statuses;

  /// Every event the server delivers, each once.
  Stream<RealtimeEvent> get events;

  /// Opens the connection and keeps it open until [disconnect].
  Future<void> connect();

  Future<void> disconnect();

  /// Drops the current connection, if any, and opens a new one now — after
  /// the app returns to the foreground, or the network changes.
  Future<void> reconnect();

  /// Asks the server to confirm one conversation and say where it stands.
  Future<SubscriptionResult> subscribe(String conversationId);

  Future<void> dispose();
}

/// The client for a build with no backend: never connects, never emits.
class DisabledRealtimeClient implements RealtimeClient {
  const DisabledRealtimeClient();

  @override
  bool get isAvailable => false;

  @override
  RealtimeStatus get status => RealtimeStatus.disconnected;

  @override
  Stream<RealtimeStatus> get statuses => const Stream.empty();

  @override
  Stream<RealtimeEvent> get events => const Stream.empty();

  @override
  Future<void> connect() async {}

  @override
  Future<void> disconnect() async {}

  @override
  Future<void> reconnect() async {}

  @override
  Future<SubscriptionResult> subscribe(String conversationId) async =>
      const SubscriptionUnavailable();

  @override
  Future<void> dispose() async {}
}

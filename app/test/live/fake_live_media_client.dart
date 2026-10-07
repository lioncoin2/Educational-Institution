import 'dart:async';

import 'package:quran_institution_app/data/media/live_media_seams.dart';
import 'package:quran_institution_app/data/models/live_media.dart';

/// A media client the test drives: it records every command and lets the test
/// emit states and inject failures. No timers, no network, no SDK — it only
/// stands in for the future provider adapter so the next slice's controller
/// can be tested against the seam.
class FakeLiveMediaClient implements LiveMediaClient {
  FakeLiveMediaClient({LiveMediaState initial = const LiveMediaIdle()})
    : _state = initial;

  final _states = StreamController<LiveMediaState>.broadcast(sync: true);
  LiveMediaState _state;

  /// Every grant passed to [connect], in order.
  final List<LiveMediaGrant> connects = [];
  int disconnects = 0;

  /// Every microphone / screen-share toggle, in order.
  final List<bool> microphoneCommands = [];
  final List<bool> screenShareCommands = [];

  /// When set, the next command method throws this and clears it.
  Object? failNext;

  /// Drives the state and notifies [states].
  void emit(LiveMediaState state) {
    _state = state;
    _states.add(state);
  }

  @override
  bool get isAvailable => true;

  @override
  LiveMediaState get state => _state;

  @override
  Stream<LiveMediaState> get states => _states.stream;

  @override
  Future<void> connect(LiveMediaGrant grant) async {
    connects.add(grant);
    _maybeFail();
  }

  @override
  Future<void> setMicrophoneEnabled(bool enabled) async {
    microphoneCommands.add(enabled);
    _maybeFail();
  }

  @override
  Future<void> setScreenShareEnabled(bool enabled) async {
    screenShareCommands.add(enabled);
    _maybeFail();
  }

  @override
  Future<void> disconnect() async {
    disconnects += 1;
  }

  void _maybeFail() {
    final error = failNext;
    if (error != null) {
      failNext = null;
      throw error;
    }
  }

  Future<void> dispose() => _states.close();
}

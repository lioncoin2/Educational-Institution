import 'dart:async';
import 'dart:typed_data';

import 'package:record/record.dart';

import '../media_seams.dart';
import 'recording_store.dart';
import 'voice_format.dart';
import 'voice_level.dart';

/// The real [VoiceRecorder], backed by `record`.
///
/// This is the ONLY file that imports `package:record`
/// (test/messaging/attachment_boundaries_test.dart enforces the confinement).
/// It records on the web — Opus in WebM (`audio/webm`) — and on Android — AAC
/// in MP4 (`audio/mp4`, ADR 0059); the backend's VOICE policy accepts both and
/// its upload completion verifies their magic bytes (`backend/.../file-policy.ts`,
/// `content-signature.ts`). Which one, and where the recording is kept until it
/// is read, is the platform's [RecordingStore]; the encoder settings follow the
/// format ([recordConfigFor]). iOS stays a separate slice (the provider binds
/// this only where `deviceMediaSupported` holds).
///
/// The raw capture is behind [VoiceRecorderPort] so the adapter's state machine
/// — single-flight start, a wall-clock duration, and a generation guard so a
/// cancel can never be overtaken by an in-flight stop — is unit-tested without
/// a microphone. ACTUAL microphone capture and the browser's encoding are NOT
/// exercised by those tests (no device in CI); they are a manual/device check.

/// What a finished recording yielded: the encoded bytes and the container's
/// content type (as produced — `audio/webm` on the web, `audio/mp4` on
/// Android).
typedef RecordingData = ({Uint8List bytes, String contentType});

/// The raw recording operations the adapter needs — a seam so the state machine
/// is testable without the plugin (which needs a real platform and a mic).
abstract interface class VoiceRecorderPort {
  /// Whether the microphone may be used (prompting if necessary).
  Future<bool> hasPermission();

  /// Begins capturing.
  Future<void> start();

  /// Finishes capturing and returns the encoded audio, or null if nothing was
  /// captured.
  Future<RecordingData?> stop();

  /// Discards the current capture and releases the microphone.
  Future<void> cancel();

  /// Releases the recorder entirely.
  Future<void> dispose();

  /// The input loudness while capturing, sampled every [interval], as a 0..1
  /// level. The stream runs only while recording and ends when it stops.
  Stream<double> amplitudes(Duration interval);
}

/// Raised when recording cannot start (e.g. the microphone permission was
/// denied). The composer catches it and shows a recoverable message; the
/// message here is never surfaced raw.
class VoiceRecordingException implements Exception {
  const VoiceRecordingException(this.code);
  final String code;
  @override
  String toString() => 'VoiceRecordingException($code)';
}

class RecordVoiceRecorder implements VoiceRecorder {
  RecordVoiceRecorder({VoiceRecorderPort? port, DateTime Function()? clock})
    : _port = port ?? RecordPluginPort(platformRecordingStore()),
      _now = clock ?? DateTime.now;

  final VoiceRecorderPort _port;
  final DateTime Function() _now;

  bool _recording = false;
  DateTime? _startedAt;

  /// Set while a [start] is still on its way — the microphone prompt is up, or
  /// the device is opening the microphone. A [stop] that arrives then (the
  /// finger lifted first) gives that start up, rather than leave it recording
  /// with nobody holding the button.
  bool _starting = false;

  /// Bumped by every [start] and [cancel], and by a [stop] that gives a pending
  /// start up; an in-flight operation tagged with an old generation does not
  /// record or emit (the stale-operation guard).
  int _generation = 0;

  @override
  bool get isSupported => true;

  /// Forwards the port's loudness stream (sampled a few times a second — smooth
  /// enough for the waveform without overworking the UI). Meaningful only while
  /// recording; the recording UI is the only subscriber and the stream ends
  /// when capture stops.
  @override
  Stream<double> get amplitudes =>
      _port.amplitudes(const Duration(milliseconds: 80));

  @override
  Future<void> start() async {
    // Single-flight: a second start, while recording or still starting, is
    // ignored.
    if (_recording || _starting) return;
    final generation = ++_generation;
    _starting = true;
    try {
      final permitted = await _port.hasPermission();
      if (generation != _generation) return; // given up while asking.
      if (!permitted) {
        throw const VoiceRecordingException('microphone_denied');
      }
      await _port.start();
      if (generation != _generation) {
        // Given up while the recorder was starting: do not leave it running.
        await _port.cancel();
        return;
      }
      _recording = true;
      _startedAt = _now();
    } finally {
      _starting = false;
    }
  }

  @override
  Future<RecordedVoice?> stop() async {
    if (!_recording) {
      // Released before recording began: give the pending start up (it then
      // never opens the microphone, or closes it at once). Nothing to send.
      if (_starting) _generation++;
      return null;
    }
    final generation = _generation;
    final startedAt = _startedAt;
    _recording = false;
    _startedAt = null;

    final data = await _port.stop();
    // Superseded by a cancel/restart while stopping, or nothing captured.
    if (generation != _generation || data == null || data.bytes.isEmpty) {
      return null;
    }
    final elapsed = startedAt == null
        ? 0
        : _now().difference(startedAt).inMilliseconds;
    return RecordedVoice(
      bytes: data.bytes,
      contentType: data.contentType,
      // Client-reported, bounded server-side; at least 1ms so an instant tap
      // still carries a valid duration.
      durationMs: elapsed < 1 ? 1 : elapsed,
    );
  }

  @override
  Future<void> cancel() async {
    _generation++;
    _recording = false;
    _startedAt = null;
    await _port.cancel();
  }

  /// Releases the recorder — called when the provider is disposed, so the
  /// microphone is never left open after the screen is gone.
  Future<void> dispose() async {
    _generation++;
    _recording = false;
    _startedAt = null;
    await _port.dispose();
  }
}

/// The capture settings for [format]: its encoder, at the shared voice budget
/// ([voiceBitRate], [voiceChannels]). Pure, so it is unit-tested directly.
RecordConfig recordConfigFor(VoiceFormat format) => RecordConfig(
  encoder: switch (format) {
    VoiceFormat.webm => AudioEncoder.opus,
    VoiceFormat.m4a => AudioEncoder.aacLc,
  },
  bitRate: voiceBitRate,
  numChannels: voiceChannels,
);

/// The production port: `record`'s [AudioRecorder], recording into the
/// platform's [RecordingStore] — which also releases the recording, whatever
/// the way out (sent, cancelled, a failed start or stop, disposed). The
/// recorder is injectable so that lifecycle is unit-tested without a device.
class RecordPluginPort implements VoiceRecorderPort {
  RecordPluginPort(this._store, [AudioRecorder? recorder])
    : _recorder = recorder ?? AudioRecorder();

  final RecordingStore _store;
  final AudioRecorder _recorder;

  @override
  Future<bool> hasPermission() => _recorder.hasPermission();

  @override
  Future<void> start() async {
    final path = await _store.prepare();
    try {
      await _recorder.start(recordConfigFor(_store.format), path: path);
    } on Object {
      await _store.discard();
      rethrow;
    }
  }

  @override
  Future<RecordingData?> stop() async {
    final String? output;
    try {
      output = await _recorder.stop();
    } on Object {
      // The device could not finish the take: treated as nothing captured, so
      // the screen returns to rest instead of waiting on a recording.
      await _store.discard();
      return null;
    }
    if (output == null) {
      await _store.discard();
      return null;
    }
    final bytes = await _store.collect(output);
    if (bytes == null) return null;
    return (bytes: bytes, contentType: _store.format.contentType);
  }

  @override
  Future<void> cancel() async {
    try {
      await _recorder.cancel();
    } finally {
      await _store.discard();
    }
  }

  @override
  Future<void> dispose() async {
    try {
      await _recorder.dispose();
    } finally {
      await _store.discard();
    }
  }

  @override
  Stream<double> amplitudes(Duration interval) => _recorder
      .onAmplitudeChanged(interval)
      .map((a) => normalizeDbfs(a.current));
}

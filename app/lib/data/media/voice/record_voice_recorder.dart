import 'dart:async';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:record/record.dart';

import '../media_seams.dart';

/// The real [VoiceRecorder], backed by `record`.
///
/// This is the ONLY file that imports `package:record`
/// (test/messaging/attachment_boundaries_test.dart enforces the confinement).
/// It is web-first: `record` on the web records Opus into a WebM container
/// (`audio/webm`), which the backend's VOICE policy accepts and whose EBML
/// magic its upload completion verifies (`backend/.../file-policy.ts`,
/// `content-signature.ts`). Native iOS/Android recording stays a separate slice
/// (the provider binds this only on web).
///
/// The raw capture is behind [VoiceRecorderPort] so the adapter's state machine
/// — single-flight start, a wall-clock duration, and a generation guard so a
/// cancel can never be overtaken by an in-flight stop — is unit-tested without
/// a microphone. ACTUAL microphone capture and the browser's encoding are NOT
/// exercised by those tests (no device in CI); they are a manual/device check.

/// What a finished recording yielded: the encoded bytes and the container's
/// content type (as produced — `audio/webm` on the web).
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
    : _port = port ?? _RecordPort(),
      _now = clock ?? DateTime.now;

  final VoiceRecorderPort _port;
  final DateTime Function() _now;

  bool _recording = false;
  DateTime? _startedAt;

  /// Bumped by every [start] and [cancel]; an in-flight [stop] tagged with an
  /// old generation does not emit a recording (the stale-operation guard).
  int _generation = 0;

  @override
  bool get isSupported => true;

  @override
  Future<void> start() async {
    if (_recording) return; // single-flight: a second start is ignored.
    final generation = ++_generation;
    final permitted = await _port.hasPermission();
    if (generation != _generation) return; // cancelled while asking.
    if (!permitted) {
      throw const VoiceRecordingException('microphone_denied');
    }
    await _port.start();
    if (generation != _generation) {
      // Cancelled while the recorder was starting: do not leave it running.
      await _port.cancel();
      return;
    }
    _recording = true;
    _startedAt = _now();
  }

  @override
  Future<RecordedVoice?> stop() async {
    if (!_recording) return null;
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

/// The production port: `record`'s [AudioRecorder], Opus → WebM on the web.
class _RecordPort implements VoiceRecorderPort {
  final AudioRecorder _recorder = AudioRecorder();

  @override
  Future<bool> hasPermission() => _recorder.hasPermission();

  @override
  Future<void> start() => _recorder.start(
    const RecordConfig(encoder: AudioEncoder.opus),
    // The web recorder captures to memory; the path is unused there. This
    // adapter is web-only (the provider gates it), so no file path is needed.
    path: '',
  );

  @override
  Future<RecordingData?> stop() async {
    final url = await _recorder.stop();
    if (url == null) return null;
    // On the web `stop()` hands back a blob: URL for the recorded object; read
    // its bytes so the upload carries the audio itself, never a URL.
    final bytes = await http.readBytes(Uri.parse(url));
    if (bytes.isEmpty) return null;
    return (bytes: bytes, contentType: 'audio/webm');
  }

  @override
  Future<void> cancel() => _recorder.cancel();

  @override
  Future<void> dispose() => _recorder.dispose();
}

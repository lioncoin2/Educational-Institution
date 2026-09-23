import 'dart:typed_data';

import '../models/messaging.dart';

/// Device capabilities messaging needs but this milestone does not bind to a
/// plugin: choosing files, recording voice, playing it back.
///
/// Each is an interface with an "unavailable" default, so every screen is
/// built and tested against the seam, and the UI states plainly what the
/// build cannot do yet. The production plugins were evaluated (see
/// docs/architecture/messaging.md, "Client dependencies") — `file_picker`,
/// `record`, `just_audio` — but not added: their native builds cannot be
/// verified in this environment, and a dependency is not added blind.

/// Picks a file for sending. Returns null when the person cancels.
abstract interface class AttachmentPicker {
  bool get isAvailable;
  Future<OutgoingFile?> pickImage();
  Future<OutgoingFile?> pickDocument();
}

class UnavailableAttachmentPicker implements AttachmentPicker {
  const UnavailableAttachmentPicker();

  @override
  bool get isAvailable => false;

  @override
  Future<OutgoingFile?> pickImage() async => null;

  @override
  Future<OutgoingFile?> pickDocument() async => null;
}

/// A finished recording, ready to send as a voice message.
class RecordedVoice {
  const RecordedVoice({
    required this.bytes,
    required this.contentType,
    required this.durationMs,
  });

  final Uint8List bytes;

  /// What recorders produce: `audio/mp4` (AAC) on iOS and Android,
  /// `audio/webm` (Opus) in Chrome — both accepted by the server.
  final String contentType;
  final int durationMs;

  OutgoingFile toOutgoingFile() => OutgoingFile(
    bytes: bytes,
    fileName: contentType == 'audio/webm' ? 'voice.webm' : 'voice.m4a',
    contentType: contentType,
    kind: AttachmentKind.voice,
    durationMs: durationMs,
  );
}

/// Records a voice message. Asynchronous audio — not a live call.
abstract interface class VoiceRecorder {
  bool get isSupported;
  Future<void> start();
  Future<RecordedVoice?> stop();
  Future<void> cancel();
}

class UnavailableVoiceRecorder implements VoiceRecorder {
  const UnavailableVoiceRecorder();

  @override
  bool get isSupported => false;

  @override
  Future<void> start() async =>
      throw UnsupportedError('Voice recording is not available in this build.');

  @override
  Future<RecordedVoice?> stop() async => null;

  @override
  Future<void> cancel() async {}
}

/// Plays a voice message from a (short-lived) URL.
abstract interface class VoicePlayer {
  bool get isSupported;
  Future<void> play(Uri url);
  Future<void> stop();
}

class UnavailableVoicePlayer implements VoicePlayer {
  const UnavailableVoicePlayer();

  @override
  bool get isSupported => false;

  @override
  Future<void> play(Uri url) async =>
      throw UnsupportedError('Audio playback is not available in this build.');

  @override
  Future<void> stop() async {}
}

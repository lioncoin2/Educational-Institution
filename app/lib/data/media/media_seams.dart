import 'dart:typed_data';

import '../models/messaging.dart';
import 'voice/voice_format.dart';

/// Device capabilities messaging needs: choosing files, recording voice,
/// playing it back.
///
/// Each is an interface with an "unavailable" default, so every screen is
/// built and tested against the seam, and the UI states plainly what the
/// build cannot do. The real implementations — over `file_picker`, `record`
/// and `just_audio`, one adapter each (docs/architecture/messaging.md, "Client
/// dependencies") — are bound on the web and Android only
/// (`deviceMediaSupportedProvider`, ADR 0059).

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
    fileName: 'voice.${VoiceFormat.ofContentType(contentType).fileExtension}',
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

  /// The live input loudness while recording, as a 0..1 level (louder is
  /// higher), for the recording waveform. A recorder that cannot report it —
  /// or is not recording — emits nothing; the waveform then simply stays flat.
  Stream<double> get amplitudes;
}

class UnavailableVoiceRecorder implements VoiceRecorder {
  const UnavailableVoiceRecorder();

  @override
  bool get isSupported => false;

  @override
  Stream<double> get amplitudes => const Stream<double>.empty();

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

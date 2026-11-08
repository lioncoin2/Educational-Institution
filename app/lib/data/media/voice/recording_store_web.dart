import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'recording_store.dart';
import 'voice_format.dart';

/// Web recordings: the browser records Opus/WebM into memory.
RecordingStore platformRecordingStore() => WebRecordingStore();

class WebRecordingStore implements RecordingStore {
  /// [read] fetches a `blob:` URL's bytes — `http.readBytes` unless a test
  /// supplies one.
  WebRecordingStore({Future<Uint8List> Function(Uri url)? read})
    : _read = read ?? http.readBytes;

  final Future<Uint8List> Function(Uri url) _read;

  @override
  VoiceFormat get format => VoiceFormat.webm;

  /// The web recorder captures to memory; the path is unused there.
  @override
  Future<String> prepare() async => '';

  /// `stop()` hands back a `blob:` URL for the recorded object; read its bytes
  /// so the upload carries the audio itself, never a URL.
  @override
  Future<Uint8List?> collect(String output) async {
    final bytes = await _read(Uri.parse(output));
    return bytes.isEmpty ? null : bytes;
  }

  /// Nothing to release: the recorder drops its in-memory capture on cancel.
  @override
  Future<void> discard() async {}
}

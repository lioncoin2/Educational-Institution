import 'dart:io';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

import 'recording_store.dart';
import 'voice_format.dart';

/// Native recordings: AAC/MP4 written to a temporary file (ADR 0059).
///
/// This is the ONLY file that imports `package:path_provider`
/// (test/messaging/attachment_boundaries_test.dart enforces the confinement).
/// Each recording gets its own file in a `voice-recordings` folder of the app's
/// cache directory; collecting it reads the bytes and deletes the file, and a
/// cancel deletes it too, so a note never outlives its upload. A file orphaned
/// by the app being killed mid-recording stays in the cache, which the system
/// clears on its own.
RecordingStore platformRecordingStore() => NativeRecordingStore();

class NativeRecordingStore implements RecordingStore {
  /// [directory] is the cache root — `getTemporaryDirectory` unless a test
  /// supplies one.
  NativeRecordingStore({Future<Directory> Function()? directory})
    : _directory = directory ?? getTemporaryDirectory;

  final Future<Directory> Function() _directory;

  /// The file of the recording in progress: prepared, not yet collected or
  /// discarded.
  String? _pending;
  int _sequence = 0;

  @override
  VoiceFormat get format => VoiceFormat.m4a;

  @override
  Future<String> prepare() async {
    final folder = Directory('${(await _directory()).path}/voice-recordings');
    await folder.create(recursive: true);
    final stamp = DateTime.now().microsecondsSinceEpoch;
    final path =
        '${folder.path}/voice-$stamp-${_sequence++}.${format.fileExtension}';
    return _pending = path;
  }

  @override
  Future<Uint8List?> collect(String output) async {
    if (_pending == output) _pending = null;
    try {
      return await File(output).readAsBytes();
    } on FileSystemException {
      return null; // nothing was written — treated as nothing captured.
    } finally {
      await _delete(output);
    }
  }

  @override
  Future<void> discard() async {
    final pending = _pending;
    _pending = null;
    if (pending != null) await _delete(pending);
  }

  static Future<void> _delete(String path) async {
    try {
      await File(path).delete();
    } on FileSystemException {
      // Already gone (the recorder's own cancel deletes it): nothing to do.
    }
  }
}

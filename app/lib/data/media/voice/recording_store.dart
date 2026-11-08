/// Where a voice recording lives on this platform between the microphone and
/// the upload, and how its bytes are read back.
///
/// The one platform difference under the `record` adapter: the browser records
/// Opus/WebM into memory and hands back a `blob:` URL; Android writes AAC/MP4
/// to a file it must be given a path for — which the app then reads and
/// deletes, so no recording is left on the device. Swapped in by conditional
/// import, as `refresh_lock` is, so the web never runs the file-based store.
library;

import 'dart:typed_data';

import 'recording_store_stub.dart'
    if (dart.library.js_interop) 'recording_store_web.dart'
    as platform;
import 'voice_format.dart';

abstract interface class RecordingStore {
  /// The container this platform records into.
  VoiceFormat get format;

  /// Readies a home for the next recording and returns the path to hand the
  /// recorder (empty where the recorder captures to memory).
  Future<String> prepare();

  /// Reads the finished recording the recorder reported at [output] (its file
  /// path, or the browser's `blob:` URL), releasing whatever held it. Null when
  /// nothing was captured.
  Future<Uint8List?> collect(String output);

  /// Drops the recording in progress, if any — a cancel, a failed start, or
  /// the recorder going away.
  Future<void> discard();
}

/// The store for this platform: a temporary file on native, the browser's
/// in-memory recording on the web.
RecordingStore platformRecordingStore() => platform.platformRecordingStore();

/// Whether this device runs the message-media plugins — picking a file,
/// recording a voice note, playing one back (`file_picker`, `record`,
/// `just_audio`; see `media_seams.dart`).
///
/// It is SDK-free on purpose, as `screen_capture_support` is: a platform fact
/// the composition root reads to bind the real adapters or the Unavailable
/// defaults (`deviceMediaSupportedProvider`).
///
/// - Web: supported — the shipped, CI-verified target since Sprint 21.
/// - Android: supported (ADR 0059) — the voice note is AAC in MP4 (`audio/mp4`),
///   which the server's VOICE policy accepts and verifies.
/// - iOS and the desktops: not yet; iOS needs a device check on a Mac first.
///
/// The native decision reads the REAL operating system (`dart:io`), never
/// `defaultTargetPlatform`: under `flutter test` that reports Android, which
/// would bind the real plugins into every widget test. Swapped in by
/// conditional import, so the web never asks `dart:io` (which throws there).
library;

export 'device_media_support_stub.dart'
    if (dart.library.js_interop) 'device_media_support_web.dart';

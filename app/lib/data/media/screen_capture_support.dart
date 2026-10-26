/// Whether this platform can CAPTURE and publish the screen for a live session.
///
/// This is the UI-gate capability (does the "share screen" control do anything
/// here), kept separate from whether the live-media client is bound at all and
/// from the server's per-session authorization. It is SDK-free on purpose — a
/// browser/platform fact, decided without touching LiveKit — so the feature
/// layer can watch it directly.
///
/// - Web: feature-detects `navigator.mediaDevices.getDisplayMedia` — the one
///   API LiveKit's web screen share needs. iOS browsers (all WebKit) lack it, so
///   a presenter there is told plainly instead of offered a share that can only
///   fail. The [platform]/[nativeScreenShareEnabled] arguments are ignored on
///   the web (the web implementation always feature-detects).
/// - Native (iOS/Android): supported only when the build opts in
///   ([nativeScreenShareEnabled], `LIVE_MEDIA_NATIVE_SCREEN_SHARE_ENABLED`), on
///   iOS or Android — the platforms with a real capture path (ADR 0051). Every
///   other native target (desktop) is unsupported. Screen capture is wired here
///   through the LiveKit adapter's platform controller
///   (`screen_capture_controllers.dart`): on Android a `mediaProjection`
///   foreground service, on iOS a ReplayKit broadcast extension.
///
/// Swapped in by conditional import, exactly as the URL strategy and invite-link
/// seams are; a widget test on the Dart VM gets the native (stub) implementation.
library;

export 'screen_capture_support_stub.dart'
    if (dart.library.js_interop) 'screen_capture_support_web.dart';

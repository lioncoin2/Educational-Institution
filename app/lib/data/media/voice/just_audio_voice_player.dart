import 'dart:async';

import 'package:just_audio/just_audio.dart';

import '../media_seams.dart';

/// The real [VoicePlayer], backed by `just_audio`.
///
/// This is the ONLY file that imports `package:just_audio`
/// (test/messaging/attachment_boundaries_test.dart enforces the confinement).
/// It plays a voice message from the short-lived, signed download URL the
/// messaging repository mints (`GET …/attachments/:id/link`) — a Range-capable
/// URL the server authorized; nothing here holds a credential. Starting a new
/// playback stops any previous one, so one player is ever audible — and a note
/// still loading when another is tapped never starts after it. Any other
/// playback failure (an expired link, an unplayable file) reaches the caller,
/// which says so.
///
/// The player is behind [VoicePlayerPort] so the orchestration (stop-then-play,
/// release on dispose) is unit-tested without the plugin, which needs a real
/// platform. Native playback is a manual/device check (no audio device in CI).

/// The playback operations the adapter needs — a seam so the orchestration is
/// testable without the plugin.
abstract interface class VoicePlayerPort {
  Future<void> setUrl(String url);
  Future<void> play();
  Future<void> stop();
  Future<void> dispose();
}

class JustAudioVoicePlayer implements VoicePlayer {
  JustAudioVoicePlayer([VoicePlayerPort? port]) : _port = port ?? _JustAudioPort();

  final VoicePlayerPort _port;

  /// Bumped by every [play] and [stop]; a play whose source finished loading
  /// after a newer play or a stop was asked for does not start.
  int _generation = 0;

  @override
  bool get isSupported => true;

  @override
  Future<void> play(Uri url) async {
    final generation = ++_generation;
    // Stop whatever was playing before pointing the player at the new source,
    // so two voice messages never overlap.
    await _port.stop();
    await _port.setUrl(url.toString());
    if (generation != _generation) return; // a newer note took over.
    await _port.play();
  }

  @override
  Future<void> stop() {
    _generation++; // a note still loading does not start after a stop either.
    return _port.stop();
  }

  /// Releases the underlying player — called when the provider is disposed.
  Future<void> dispose() => _port.dispose();
}

/// The production port: `just_audio`'s [AudioPlayer].
class _JustAudioPort implements VoicePlayerPort {
  final AudioPlayer _player = AudioPlayer();

  @override
  Future<void> setUrl(String url) async {
    try {
      await _player.setUrl(url);
    } on PlayerInterruptedException {
      // A newer source replaced this one while it loaded — the expected result
      // of tapping another note; the adapter's generation drops this play.
    }
  }

  @override
  Future<void> play() => _player.play();

  @override
  Future<void> stop() => _player.stop();

  @override
  Future<void> dispose() => _player.dispose();
}

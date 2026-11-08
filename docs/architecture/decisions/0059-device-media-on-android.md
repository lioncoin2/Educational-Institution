# 0059 — Device media on Android: voice notes, playback and attachments

**Status:** Accepted (2026-11-08, the owner approved the plan)
**Date:** 2026-11-08

## Context

The three message-media seams — `AttachmentPicker`, `VoiceRecorder`,
`VoicePlayer` (`lib/data/media/media_seams.dart`) — got real adapters in
Sprint 21 over `file_picker`, `record` and `just_audio`, but were bound on the
web only (`deviceMediaSupportedProvider = kIsWeb`): the web was the shipped,
CI-verified target, and native media (P7b) waited on a device. On the Android
app the mic is therefore disabled («التسجيل الصوتي غير متاح في هذا الإصدار»),
voice notes cannot be played, and nothing can be attached. The owner asked for
voice messages in chat on the phone.

What the inspection found:

- The adapters are already platform-neutral except ONE piece: the recorder's
  production port recorded Opus to memory and read the browser's `blob:` URL.
  The player plays an absolute signed URL (`ApiClient.resolve`); the picker
  reads bytes through `PlatformFile.readAsBytes`, which Android backs with the
  picked file's cached copy.
- The server already accepts Android's natural recording: VOICE allows
  `audio/mp4` and verifies the `ftyp` box, which `record`'s AAC-LC encoder
  writes. No backend change is needed.
- `defaultTargetPlatform` cannot decide this: under `flutter test` it reports
  Android, so a policy written on it would bind the real plugins into every
  widget test that builds a composer, a voice bubble or a picker screen.
- `record`'s defaults (128 kbit/s, stereo) overrun the VOICE cap: past about
  5.5 minutes a note exceeded 5 MiB and was refused, though the server allows
  10 minutes.
- An independent review found races that the web hid but Android exposes: on
  first use the microphone prompt is up while `start()` waits, and a finger
  lifted then (a `stop`) was ignored — the start went on recording with no UI,
  and the next hold sent that audio. The recorder is one app-wide instance, and
  neither the composer nor bulk publish released a recording when the screen
  went away. A failed playback was silent.

## Decision

1. **Bind the device media on Android** as on the web. The policy is
   `deviceMediaSupported()` (`lib/data/media/device_media_support.dart`), a
   platform fact swapped in by conditional import like `screen_capture_support`:
   the web → true; native → the host's REAL operating system is Android
   (`dart:io Platform.operatingSystem`), so a VM test host reads false and keeps
   the Unavailable defaults. iOS and the desktops stay unsupported. No build
   flag: the capability has no server or infrastructure precondition, and a flag
   left out of a build is how a store build ships without a feature.
2. **A `RecordingStore` per platform** (`lib/data/media/voice/recording_store*.dart`)
   owns where a recording lives between the microphone and the upload, and the
   container it is in: the web records Opus/WebM to memory (`blob:` URL, read
   with `package:http`, as before); Android records AAC-LC in MP4 to its own file
   in the cache directory (`path_provider`), which collecting reads and deletes,
   and a cancel, a failed start or stop, or a dispose deletes too. The `record`
   adapter (`RecordPluginPort`) stays the only `record` import, takes the store,
   and its plugin is injectable so that lifecycle is unit-tested.
3. **AAC/MP4 on Android**, not Opus/Ogg (which Android 10+ can also record):
   MP4/AAC plays in every browser and on iOS, so a note sent from a phone is heard
   everywhere; the web's WebM/Opus plays on Android (ExoPlayer).
4. **One voice budget for every format** (`voice_format.dart`): 48 kbit/s, mono —
   clear speech in Opus or AAC; the longest note the server accepts (10 minutes)
   is then ≈ 3.6 MB of audio, a quarter under the 5 MiB cap with room for the
   MP4 index and an encoder over its target. This also changes the web recording
   (it was 128 kbit/s stereo), fixing the long-note refusal there. A recording's
   file name follows its format (`VoiceFormat.ofContentType`), one owner.
5. **A recording is never left running unseen.** The recorder's start is
   single-flight while it is still starting, and a `stop` that arrives before
   recording began gives that start up (the microphone is never opened, or is
   closed at once). The composer and bulk publish discard a recording still in
   progress when they are disposed.
6. **Failures are said, not swallowed.** Bulk publish tells a refused microphone
   («تعذّر بدء التسجيل») as the composer already did; the voice bubble tells a
   note the device cannot play («تعذّر تشغيل الرسالة الصوتية»); a note still
   loading when another is tapped never starts after it. The picker drops
   Android's cached copy of a pick once its bytes are read (best effort).

## Consequences

- On Android: hold-to-record sends a voice note, voice notes play, and images
  and PDFs can be attached — in chat and on every screen that uses the same
  picker (avatar, community picture, programme cover, bulk publish).
- `path_provider` becomes a direct dependency (it was already in the graph,
  transitively — no new package); it is confined to the native store, as the
  other plugins are to their adapters (`attachment_boundaries_test.dart`).
- No backend, route, permission, model or migration change.
- Verified here: `flutter analyze`, the full Flutter suite (with a mutation
  check that the start/stop race tests fail without the fix), a web build whose
  bundle carries the web recording store and not the file-based one, and a
  signed Android build. NOT verified here — no emulator on this host: real
  microphone capture, playback and picking on a phone. That is the owner's
  device check before a store release.
- Known limit: `record` pauses a capture when Android takes the audio focus
  (a call, an alarm) and does not resume it, so such a note is sent short.
- Still not on the phone (unchanged, out of scope): opening a received PDF
  (`openExternalUrl` is web-only; it needs `url_launcher`), and iOS (needs a Mac
  and an iPhone to verify).

## Alternatives rejected

- **`defaultTargetPlatform == android`:** wrong under `flutter test` (above).
- **A build flag (`DEVICE_MEDIA_NATIVE_ENABLED`):** nothing to gate on the
  server side; it only adds a way to ship a build without the feature.
- **Opus/Ogg on Android:** not playable on Safari/iOS.
- **`Directory.systemTemp` instead of `path_provider`:** on Android it is not
  the app's cache directory the system manages and clears.

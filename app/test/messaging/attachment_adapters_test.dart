import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/media_seams.dart';
import 'package:quran_institution_app/data/media/pickers/file_picker_attachment_picker.dart';
import 'package:quran_institution_app/data/media/voice/just_audio_voice_player.dart';
import 'package:quran_institution_app/data/media/voice/record_voice_recorder.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// The Sprint 21 device-media adapters, tested at their seams with fakes — no
/// plugin, no platform. ACTUAL file picking, microphone capture and audio
/// playback are NOT exercised here (no device in CI); the web build proves the
/// adapters compile and bind, and real capture/playback is a manual check.
void main() {
  Uint8List bytes(int n) => Uint8List.fromList(List<int>.filled(n, 1));

  group('FilePickerAttachmentPicker', () {
    test('pickImage maps a picked PNG to an image OutgoingFile', () async {
      final picker = FilePickerAttachmentPicker(
        (_) async => PickedFile('board.png', bytes(64)),
      );
      final file = await picker.pickImage();
      expect(file, isNotNull);
      expect(file!.kind, AttachmentKind.image);
      expect(file.contentType, 'image/png');
      expect(file.fileName, 'board.png');
      expect(file.bytes.length, 64);
    });

    test('pickDocument maps a picked PDF to a document OutgoingFile', () async {
      final picker = FilePickerAttachmentPicker(
        (_) async => PickedFile('اللائحة.pdf', bytes(8)),
      );
      final file = await picker.pickDocument();
      expect(file!.kind, AttachmentKind.document);
      expect(file.contentType, 'application/pdf');
      expect(file.fileName, 'اللائحة.pdf');
    });

    test('cancellation (null) returns null — a normal no-op', () async {
      final picker = FilePickerAttachmentPicker((_) async => null);
      expect(await picker.pickImage(), isNull);
    });

    test('a read/permission failure is graceful (null, never a throw)', () async {
      final picker = FilePickerAttachmentPicker(
        (_) async => throw StateError('denied'),
      );
      expect(await picker.pickImage(), isNull);
    });

    test('an empty selection returns null', () async {
      final picker = FilePickerAttachmentPicker(
        (_) async => PickedFile('x.png', Uint8List(0)),
      );
      expect(await picker.pickImage(), isNull);
    });

    test('content type is derived from the extension', () {
      String typeOf(String name, AttachmentKind kind) =>
          outgoingFromPicked(PickedFile(name, bytes(1)), kind).contentType;
      expect(typeOf('a.jpg', AttachmentKind.image), 'image/jpeg');
      expect(typeOf('a.jpeg', AttachmentKind.image), 'image/jpeg');
      expect(typeOf('a.PNG', AttachmentKind.image), 'image/png');
      expect(typeOf('a.webp', AttachmentKind.image), 'image/webp');
      expect(typeOf('a.pdf', AttachmentKind.document), 'application/pdf');
      // No extension → the kind's canonical type (server stays authoritative).
      expect(typeOf('noext', AttachmentKind.image), 'image/jpeg');
    });
  });

  group('RecordVoiceRecorder', () {
    test('start then stop yields a voice with a measured duration', () async {
      var now = DateTime.utc(2026, 1, 1, 0, 0, 0);
      final port = _FakeRecorderPort(data: (bytes: bytes(32), contentType: 'audio/webm'));
      final recorder = RecordVoiceRecorder(port: port, clock: () => now);

      await recorder.start();
      expect(port.started, 1);
      now = now.add(const Duration(milliseconds: 3200));
      final voice = await recorder.stop();

      expect(voice, isNotNull);
      expect(voice!.contentType, 'audio/webm');
      expect(voice.durationMs, 3200);
      expect(voice.bytes.length, 32);
      // The outgoing file carries the voice kind and a .webm name.
      expect(voice.toOutgoingFile().kind, AttachmentKind.voice);
      expect(voice.toOutgoingFile().fileName, 'voice.webm');
    });

    test('a denied microphone makes start throw (composer shows a message)', () async {
      final port = _FakeRecorderPort(permitted: false);
      final recorder = RecordVoiceRecorder(port: port, clock: DateTime.now);
      await expectLater(
        recorder.start(),
        throwsA(isA<VoiceRecordingException>()),
      );
      expect(port.started, 0);
    });

    test('stop without a start is a no-op', () async {
      final recorder = RecordVoiceRecorder(port: _FakeRecorderPort(), clock: DateTime.now);
      expect(await recorder.stop(), isNull);
    });

    test('a second start is ignored while recording (single-flight)', () async {
      final port = _FakeRecorderPort(data: (bytes: bytes(4), contentType: 'audio/webm'));
      final recorder = RecordVoiceRecorder(port: port, clock: DateTime.now);
      await recorder.start();
      await recorder.start();
      expect(port.started, 1);
    });

    test('cancel releases the mic and a superseded stop never emits', () async {
      final port = _FakeRecorderPort(data: (bytes: bytes(4), contentType: 'audio/webm'));
      final recorder = RecordVoiceRecorder(port: port, clock: DateTime.now);
      await recorder.start();
      port.gateStop = Completer<void>();
      final stopping = recorder.stop();
      await recorder.cancel(); // bumps the generation while stop is in flight
      port.gateStop!.complete();
      expect(await stopping, isNull); // stale — does not emit a recording
      expect(port.cancelled, greaterThanOrEqualTo(1));
    });

    test('dispose releases the recorder', () async {
      final port = _FakeRecorderPort();
      await RecordVoiceRecorder(port: port, clock: DateTime.now).dispose();
      expect(port.disposed, 1);
    });
  });

  group('JustAudioVoicePlayer', () {
    test('play stops any prior audio, sets the url, then plays', () async {
      final port = _FakePlayerPort();
      final player = JustAudioVoicePlayer(port);
      await player.play(Uri.parse('https://api.test/files/local/tok?sig=x'));
      expect(port.log, ['stop', 'setUrl:https://api.test/files/local/tok?sig=x', 'play']);
    });

    test('a second play stops the first before switching source', () async {
      final port = _FakePlayerPort();
      final player = JustAudioVoicePlayer(port);
      await player.play(Uri.parse('https://api.test/a'));
      port.log.clear();
      await player.play(Uri.parse('https://api.test/b'));
      expect(port.log, ['stop', 'setUrl:https://api.test/b', 'play']);
    });

    test('stop and dispose delegate', () async {
      final port = _FakePlayerPort();
      final player = JustAudioVoicePlayer(port);
      await player.stop();
      await player.dispose();
      expect(port.log, ['stop']);
      expect(port.disposed, 1);
    });
  });

  group('provider selection', () {
    test('unsupported target → the Unavailable defaults (fail closed)', () {
      final container = ProviderContainer(
        overrides: [deviceMediaSupportedProvider.overrideWithValue(false)],
      );
      addTearDown(container.dispose);
      expect(
        container.read(attachmentPickerProvider),
        isA<UnavailableAttachmentPicker>(),
      );
      expect(
        container.read(voiceRecorderProvider),
        isA<UnavailableVoiceRecorder>(),
      );
      expect(
        container.read(voicePlayerProvider),
        isA<UnavailableVoicePlayer>(),
      );
    });

    test('supported target → the real picker is bound', () {
      // The real picker is a const with no plugin touch until a pick, so it is
      // safe to construct here; the recorder/player hold a device resource and
      // are covered by their own fake-port tests + the web build.
      final container = ProviderContainer(
        overrides: [deviceMediaSupportedProvider.overrideWithValue(true)],
      );
      addTearDown(container.dispose);
      expect(
        container.read(attachmentPickerProvider),
        isA<FilePickerAttachmentPicker>(),
      );
      expect(container.read(attachmentPickerProvider).isAvailable, isTrue);
    });

    test('a plain container (VM default, non-web) → Unavailable', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      expect(
        container.read(attachmentPickerProvider),
        isA<UnavailableAttachmentPicker>(),
      );
    });
  });
}

class _FakeRecorderPort implements VoiceRecorderPort {
  _FakeRecorderPort({this.permitted = true, this.data});

  final bool permitted;
  final RecordingData? data;
  int started = 0;
  int cancelled = 0;
  int disposed = 0;
  Completer<void>? gateStop;

  @override
  Future<bool> hasPermission() async => permitted;

  @override
  Future<void> start() async => started++;

  @override
  Future<RecordingData?> stop() async {
    if (gateStop != null) await gateStop!.future;
    return data;
  }

  @override
  Future<void> cancel() async => cancelled++;

  @override
  Future<void> dispose() async => disposed++;
}

class _FakePlayerPort implements VoicePlayerPort {
  final List<String> log = [];
  int disposed = 0;

  @override
  Future<void> setUrl(String url) async => log.add('setUrl:$url');

  @override
  Future<void> play() async => log.add('play');

  @override
  Future<void> stop() async => log.add('stop');

  @override
  Future<void> dispose() async => disposed++;
}

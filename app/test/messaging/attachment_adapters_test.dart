import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/media_seams.dart';
import 'package:quran_institution_app/data/media/pickers/file_picker_attachment_picker.dart';
import 'package:quran_institution_app/data/media/voice/just_audio_voice_player.dart';
import 'package:quran_institution_app/data/media/voice/record_voice_recorder.dart';
import 'package:quran_institution_app/data/media/voice/recording_store.dart';
import 'package:quran_institution_app/data/media/voice/voice_format.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/providers/app_providers.dart';
import 'package:record/record.dart'
    show AudioEncoder, AudioRecorder, RecordConfig;

/// The Sprint 21 device-media adapters, tested at their seams with fakes — no
/// plugin, no platform. ACTUAL file picking, microphone capture and audio
/// playback are NOT exercised here (no device in CI); the web and Android
/// builds prove the adapters compile and bind, and real capture/playback is a
/// manual check on a browser and a phone (ADR 0059).
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

    test(
      'a read/permission failure is graceful (null, never a throw)',
      () async {
        final picker = FilePickerAttachmentPicker(
          (_) async => throw StateError('denied'),
        );
        expect(await picker.pickImage(), isNull);
      },
    );

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
      final port = _FakeRecorderPort(
        data: (bytes: bytes(32), contentType: 'audio/webm'),
      );
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

    test(
      'forwards the port loudness stream for the recording waveform',
      () async {
        final port = _FakeRecorderPort()..levels = const [0.0, 0.5, 1.0];
        final recorder = RecordVoiceRecorder(port: port, clock: DateTime.now);
        expect(await recorder.amplitudes.toList(), const [0.0, 0.5, 1.0]);
      },
    );

    test(
      'a denied microphone makes start throw (composer shows a message)',
      () async {
        final port = _FakeRecorderPort(permitted: false);
        final recorder = RecordVoiceRecorder(port: port, clock: DateTime.now);
        await expectLater(
          recorder.start(),
          throwsA(isA<VoiceRecordingException>()),
        );
        expect(port.started, 0);
      },
    );

    test('stop without a start is a no-op', () async {
      final recorder = RecordVoiceRecorder(
        port: _FakeRecorderPort(),
        clock: DateTime.now,
      );
      expect(await recorder.stop(), isNull);
    });

    test('a second start is ignored while recording (single-flight)', () async {
      final port = _FakeRecorderPort(
        data: (bytes: bytes(4), contentType: 'audio/webm'),
      );
      final recorder = RecordVoiceRecorder(port: port, clock: DateTime.now);
      await recorder.start();
      await recorder.start();
      expect(port.started, 1);
    });

    test('cancel releases the mic and a superseded stop never emits', () async {
      final port = _FakeRecorderPort(
        data: (bytes: bytes(4), contentType: 'audio/webm'),
      );
      final recorder = RecordVoiceRecorder(port: port, clock: DateTime.now);
      await recorder.start();
      port.gateStop = Completer<void>();
      final stopping = recorder.stop();
      await recorder.cancel(); // bumps the generation while stop is in flight
      port.gateStop!.complete();
      expect(await stopping, isNull); // stale — does not emit a recording
      expect(port.cancelled, greaterThanOrEqualTo(1));
    });

    // Android asks for the microphone on first use: its prompt is up while
    // start() waits, and the hold ends — a cancel, or a release — before the
    // answer arrives. Neither may leave a recording running unseen.
    test(
      'a cancel while the microphone prompt is open never starts recording',
      () async {
        final port = _FakeRecorderPort()..gatePermission = Completer<bool>();
        final recorder = RecordVoiceRecorder(port: port, clock: DateTime.now);
        final starting = recorder.start();
        await recorder.cancel();
        port.gatePermission!.complete(true);
        await starting;
        expect(port.started, 0);
        expect(await recorder.stop(), isNull);
      },
    );

    test(
      'a release while the microphone prompt is open gives the start up',
      () async {
        final port = _FakeRecorderPort(
          data: (bytes: bytes(4), contentType: 'audio/mp4'),
        )..gatePermission = Completer<bool>();
        final recorder = RecordVoiceRecorder(port: port, clock: DateTime.now);
        final starting = recorder.start();
        expect(await recorder.stop(), isNull); // nothing recorded yet
        port.gatePermission!.complete(true);
        await starting;
        expect(port.started, 0); // the microphone was never opened
        // The next hold records afresh — nothing left over from the first.
        port.gatePermission = null;
        await recorder.start();
        expect(port.started, 1);
        expect(await recorder.stop(), isNotNull);
      },
    );

    test(
      'a release while the device opens the microphone closes it again',
      () async {
        final port = _FakeRecorderPort()..gateStart = Completer<void>();
        final recorder = RecordVoiceRecorder(port: port, clock: DateTime.now);
        final starting = recorder.start();
        await pumpEventQueue();
        expect(port.started, 1); // the device is opening the microphone
        expect(await recorder.stop(), isNull);
        port.gateStart!.complete();
        await starting;
        expect(port.cancelled, 1); // closed at once, not left recording
        expect(await recorder.stop(), isNull);
      },
    );

    test('a second start while one is starting is ignored', () async {
      final port = _FakeRecorderPort()..gatePermission = Completer<bool>();
      final recorder = RecordVoiceRecorder(port: port, clock: DateTime.now);
      final first = recorder.start();
      final second = recorder.start();
      port.gatePermission!.complete(true);
      await Future.wait([first, second]);
      expect(port.started, 1);
    });

    test('an Android recording goes out as voice.m4a (audio/mp4)', () {
      final file = RecordedVoice(
        bytes: bytes(2),
        contentType: VoiceFormat.m4a.contentType,
        durationMs: 5,
      ).toOutgoingFile();
      expect(file.kind, AttachmentKind.voice);
      expect(file.contentType, 'audio/mp4');
      expect(file.fileName, 'voice.m4a');
    });

    test('dispose releases the recorder', () async {
      final port = _FakeRecorderPort();
      await RecordVoiceRecorder(port: port, clock: DateTime.now).dispose();
      expect(port.disposed, 1);
    });
  });

  group('RecordPluginPort (a take is released whatever the way out)', () {
    late _FakeStore store;
    late _FakeAudioRecorder plugin;
    late RecordPluginPort port;

    setUp(() {
      store = _FakeStore();
      plugin = _FakeAudioRecorder();
      port = RecordPluginPort(store, plugin);
    });

    test("starts into the store's file, at its format's settings", () async {
      await port.start();
      expect(plugin.path, '/cache/take-1.m4a');
      expect(plugin.config!.encoder, AudioEncoder.aacLc);
      expect(store.discarded, 0);
    });

    test('a failed start discards the take and reports the failure', () async {
      plugin.failStart = true;
      await expectLater(port.start(), throwsA(isA<StateError>()));
      expect(store.discarded, 1);
    });

    test('stop collects the take the plugin reports, by its format', () async {
      await port.start();
      plugin.output = '/cache/take-1.m4a';
      final data = await port.stop();
      expect(store.collected, ['/cache/take-1.m4a']);
      expect(data!.contentType, 'audio/mp4');
      expect(data.bytes, [1, 2]);
    });

    test('nothing captured discards the take and yields nothing', () async {
      await port.start();
      expect(await port.stop(), isNull); // the plugin reported no output
      expect(store.discarded, 1);
      expect(store.collected, isEmpty);
    });

    test('a failed stop discards the take and yields nothing', () async {
      await port.start();
      plugin.failStop = true;
      expect(await port.stop(), isNull);
      expect(store.discarded, 1);
    });

    test('cancel and dispose discard, even when the plugin throws', () async {
      plugin.failCancel = true;
      await expectLater(port.cancel(), throwsA(isA<StateError>()));
      expect(store.discarded, 1);
      await port.dispose();
      expect(store.discarded, 2);
      expect(plugin.disposed, isTrue);
    });
  });

  group('recordConfigFor (the voice budget)', () {
    test('Android records AAC-LC, the web Opus', () {
      expect(recordConfigFor(VoiceFormat.m4a).encoder, AudioEncoder.aacLc);
      expect(recordConfigFor(VoiceFormat.webm).encoder, AudioEncoder.opus);
    });

    test('every format records at 48 kbit/s, mono', () {
      for (final format in VoiceFormat.values) {
        final config = recordConfigFor(format);
        expect(config.bitRate, 48000, reason: format.name);
        expect(config.numChannels, 1, reason: format.name);
      }
    });

    test('the longest note the server takes fits its size cap', () {
      // backend/src/modules/files/domain/file-policy.ts: VOICE is capped at
      // 5 MiB and MAX_VOICE_DURATION_MS (10 minutes). Keep a quarter of the cap
      // spare for the container's index and an encoder over its target.
      const maxBytes = 5 * 1024 * 1024;
      const maxSeconds = 10 * 60;
      expect(voiceBitRate * maxSeconds ~/ 8, lessThan(maxBytes * 0.75));
    });
  });

  group('JustAudioVoicePlayer', () {
    test('play stops any prior audio, sets the url, then plays', () async {
      final port = _FakePlayerPort();
      final player = JustAudioVoicePlayer(port);
      await player.play(Uri.parse('https://api.test/files/local/tok?sig=x'));
      expect(port.log, [
        'stop',
        'setUrl:https://api.test/files/local/tok?sig=x',
        'play',
      ]);
    });

    test('a second play stops the first before switching source', () async {
      final port = _FakePlayerPort();
      final player = JustAudioVoicePlayer(port);
      await player.play(Uri.parse('https://api.test/a'));
      port.log.clear();
      await player.play(Uri.parse('https://api.test/b'));
      expect(port.log, ['stop', 'setUrl:https://api.test/b', 'play']);
    });

    test('a note still loading when another is tapped never starts', () async {
      final port = _FakePlayerPort()..gateSetUrl = Completer<void>();
      final player = JustAudioVoicePlayer(port);
      final first = player.play(Uri.parse('https://api.test/a'));
      await pumpEventQueue(); // a is loading
      port.gateSetUrl = null;
      await player.play(Uri.parse('https://api.test/b'));
      port.firstGate!.complete(); // a's source finishes loading — too late
      await first;
      expect(port.log, [
        'stop',
        'setUrl:https://api.test/a',
        'stop',
        'setUrl:https://api.test/b',
        'play', // b only
      ]);
    });

    test('a stop while a note loads keeps it from starting', () async {
      final port = _FakePlayerPort()..gateSetUrl = Completer<void>();
      final player = JustAudioVoicePlayer(port);
      final playing = player.play(Uri.parse('https://api.test/a'));
      await pumpEventQueue();
      await player.stop();
      port.firstGate!.complete();
      await playing;
      expect(port.log, ['stop', 'setUrl:https://api.test/a', 'stop']);
    });

    test(
      'a playback failure reaches the caller (the bubble says so)',
      () async {
        final port = _FakePlayerPort()..failSetUrl = true;
        await expectLater(
          JustAudioVoicePlayer(port).play(Uri.parse('https://api.test/x')),
          throwsA(isA<StateError>()),
        );
        expect(port.log, isNot(contains('play')));
      },
    );

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

  /// Holds the permission answer open, as a system prompt does, if set.
  Completer<bool>? gatePermission;

  /// Holds the device's start open, as opening the microphone does, if set.
  Completer<void>? gateStart;

  /// Scripted loudness the recorder should forward, if a test asks for it.
  List<double> levels = const [];

  @override
  Future<bool> hasPermission() async =>
      gatePermission == null ? permitted : await gatePermission!.future;

  @override
  Stream<double> amplitudes(Duration interval) => Stream.fromIterable(levels);

  @override
  Future<void> start() async {
    started++;
    if (gateStart != null) await gateStart!.future;
  }

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

  /// Holds a source's loading open, if set (kept as [firstGate]).
  Completer<void>? gateSetUrl;
  Completer<void>? firstGate;
  bool failSetUrl = false;

  @override
  Future<void> setUrl(String url) async {
    log.add('setUrl:$url');
    if (failSetUrl) throw StateError('unplayable');
    final gate = gateSetUrl;
    if (gate != null) {
      firstGate = gate;
      await gate.future;
    }
  }

  @override
  Future<void> play() async => log.add('play');

  @override
  Future<void> stop() async => log.add('stop');

  @override
  Future<void> dispose() async => disposed++;
}

/// A [RecordingStore] that hands out numbered paths and records what was
/// collected and discarded.
class _FakeStore implements RecordingStore {
  int _takes = 0;
  final List<String> collected = [];
  int discarded = 0;

  @override
  VoiceFormat get format => VoiceFormat.m4a;

  @override
  Future<String> prepare() async =>
      '/cache/take-${++_takes}.${format.fileExtension}';

  @override
  Future<Uint8List?> collect(String output) async {
    collected.add(output);
    return Uint8List.fromList([1, 2]);
  }

  @override
  Future<void> discard() async => discarded++;
}

/// Stands in for `record`'s plugin, scripted to succeed or fail.
class _FakeAudioRecorder extends Fake implements AudioRecorder {
  RecordConfig? config;
  String? path;
  String? output;
  bool failStart = false;
  bool failStop = false;
  bool failCancel = false;
  bool disposed = false;

  @override
  Future<void> start(RecordConfig config, {required String path}) async {
    if (failStart) throw StateError('no microphone');
    this.config = config;
    this.path = path;
  }

  @override
  Future<String?> stop() async {
    if (failStop) throw StateError('encoder failed');
    return output;
  }

  @override
  Future<void> cancel() async {
    if (failCancel) throw StateError('cancel failed');
  }

  @override
  Future<void> dispose() async => disposed = true;
}

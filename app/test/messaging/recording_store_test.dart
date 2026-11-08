import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/voice/recording_store_stub.dart';
import 'package:quran_institution_app/data/media/voice/recording_store_web.dart';
import 'package:quran_institution_app/data/media/voice/voice_format.dart';

/// Where a voice recording lives between the microphone and the upload
/// (ADR 0059). The native store runs against a real temporary directory — the
/// file handling IS the behavior; the web store reads the browser's `blob:`
/// URL through an injected reader. Actual capture stays a device check.
void main() {
  group('NativeRecordingStore', () {
    late Directory cache;
    late NativeRecordingStore store;

    setUp(() async {
      cache = await Directory.systemTemp.createTemp('recording-store-test');
      store = NativeRecordingStore(directory: () async => cache);
    });
    tearDown(() => cache.delete(recursive: true));

    /// What the recorder does between `prepare` and `stop`: writes the file.
    Future<String> record(List<int> bytes) async {
      final path = await store.prepare();
      await File(path).writeAsBytes(bytes);
      return path;
    }

    test('records AAC in MP4 — the container the server accepts', () {
      expect(store.format, VoiceFormat.m4a);
      expect(store.format.contentType, 'audio/mp4');
    });

    test('prepares a fresh .m4a file in its own cache folder', () async {
      final first = await store.prepare();
      final second = await store.prepare();
      expect(first, isNot(second));
      for (final path in [first, second]) {
        expect(path, startsWith('${cache.path}/voice-recordings/'));
        expect(path, endsWith('.m4a'));
      }
      expect(Directory('${cache.path}/voice-recordings').existsSync(), isTrue);
    });

    test('collect reads the recording and deletes its file', () async {
      final path = await record([1, 2, 3]);
      expect(await store.collect(path), Uint8List.fromList([1, 2, 3]));
      expect(File(path).existsSync(), isFalse);
    });

    test('collect of a file never written is nothing captured', () async {
      final path = await store.prepare();
      expect(await store.collect(path), isNull);
    });

    test('discard deletes the recording in progress', () async {
      final path = await record([4, 5]);
      await store.discard();
      expect(File(path).existsSync(), isFalse);
    });

    test('discard with nothing begun is a no-op', () async {
      await store.discard();
      final path = await record([6]);
      expect(await store.collect(path), [6]);
      await store.discard(); // already collected: nothing left to drop
      expect(File(path).existsSync(), isFalse);
    });

    test(
      'collecting an earlier note still discards the one in progress',
      () async {
        final earlier = await record([7]);
        final current = await record([8]);
        await store.collect(earlier);
        expect(File(current).existsSync(), isTrue);
        await store.discard();
        expect(File(current).existsSync(), isFalse);
      },
    );
  });

  group('WebRecordingStore', () {
    test('records Opus in WebM, to memory (no path)', () async {
      final store = WebRecordingStore(read: (_) async => Uint8List(0));
      expect(store.format, VoiceFormat.webm);
      expect(store.format.contentType, 'audio/webm');
      expect(await store.prepare(), '');
    });

    test('collect reads the blob: URL the recorder handed back', () async {
      Uri? asked;
      final store = WebRecordingStore(
        read: (url) async {
          asked = url;
          return Uint8List.fromList([9, 9]);
        },
      );
      expect(await store.collect('blob:https://app/1'), [9, 9]);
      expect(asked, Uri.parse('blob:https://app/1'));
    });

    test('an empty recording is nothing captured', () async {
      final store = WebRecordingStore(read: (_) async => Uint8List(0));
      expect(await store.collect('blob:https://app/2'), isNull);
    });
  });
}

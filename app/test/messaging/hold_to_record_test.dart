import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/media_seams.dart';
import 'package:quran_institution_app/data/models/messaging.dart';
import 'package:quran_institution_app/features/messaging/widgets/composer.dart';
import 'package:quran_institution_app/features/messaging/widgets/hold_to_record.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// Hold-to-record (ADR 0057): the gesture wrapper reports start/arm/end, and the
/// composer drives the recorder — hold to record, release to send, slide to
/// cancel, and a quick tap only hints.
void main() {
  Widget host(Widget child) => MaterialApp(
    home: Scaffold(
      body: Directionality(textDirection: TextDirection.rtl, child: child),
    ),
  );

  group('HoldToRecord gesture', () {
    Future<void> hold(
      WidgetTester tester, {
      double slideDx = 0,
      required void Function() onStart,
      required ValueChanged<bool> onArmed,
      required void Function({required bool cancelled}) onEnd,
    }) async {
      await tester.pumpWidget(
        host(
          HoldToRecord(
            enabled: true,
            onStart: onStart,
            onCancelArmedChanged: onArmed,
            onEnd: onEnd,
            child: const SizedBox(
              key: Key('target'),
              width: 48,
              height: 48,
              child: ColoredBox(color: Colors.blue),
            ),
          ),
        ),
      );
      final g = await tester.startGesture(
        tester.getCenter(find.byKey(const Key('target'))),
      );
      await tester.pump(); // register the pointer
      await tester.pump(const Duration(milliseconds: 600)); // long-press fires
      if (slideDx != 0) {
        await g.moveBy(Offset(slideDx, 0));
        await tester.pump();
      }
      await g.up();
      await tester.pump();
    }

    testWidgets('hold, release → start fired and ended uncancelled', (
      tester,
    ) async {
      var started = false;
      bool? endedCancelled;
      await hold(
        tester,
        onStart: () => started = true,
        onArmed: (_) {},
        onEnd: ({required cancelled}) => endedCancelled = cancelled,
      );
      expect(started, isTrue);
      expect(endedCancelled, isFalse);
    });

    testWidgets('sliding past the threshold arms cancel and discards', (
      tester,
    ) async {
      bool? endedCancelled;
      final armed = <bool>[];
      await hold(
        tester,
        slideDx: 140,
        onStart: () {},
        onArmed: armed.add,
        onEnd: ({required cancelled}) => endedCancelled = cancelled,
      );
      expect(armed.last, isTrue);
      expect(endedCancelled, isTrue);
    });

    testWidgets('a quick tap hints, never starts', (tester) async {
      var started = false;
      var tapped = false;
      await tester.pumpWidget(
        host(
          HoldToRecord(
            enabled: true,
            onStart: () => started = true,
            onCancelArmedChanged: (_) {},
            onEnd: ({required cancelled}) {},
            onQuickTap: () => tapped = true,
            child: const SizedBox(
              key: Key('target'),
              width: 48,
              height: 48,
              child: ColoredBox(color: Colors.blue),
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(const Key('target')));
      await tester.pump();
      expect(tapped, isTrue);
      expect(started, isFalse);
    });
  });

  group('composer', () {
    testWidgets('holding the mic records and releasing sends', (tester) async {
      final recorder = _FakeRecorder();
      OutgoingFile? sent;
      await tester.pumpWidget(
        ProviderScope(
          overrides: [voiceRecorderProvider.overrideWithValue(recorder)],
          child: host(
            Composer(
              onSendText: (_) {},
              onSendFile: (f) => sent = f,
            ),
          ),
        ),
      );
      final g = await tester.startGesture(
        tester.getCenter(find.byIcon(Icons.mic_none_rounded)),
      );
      await tester.pump(); // register the pointer
      await tester.pump(const Duration(milliseconds: 600)); // long-press fires
      await tester.pump(); // start() resolves, recording UI shows
      expect(recorder.started, isTrue);
      expect(find.byKey(const Key('composer-recording-strip')), findsOneWidget);
      await g.up();
      await tester.pumpAndSettle();
      expect(recorder.stopped, isTrue);
      expect(sent, isNotNull);
      expect(sent!.kind, AttachmentKind.voice);
    });
  });
}

class _FakeRecorder implements VoiceRecorder {
  bool started = false;
  bool stopped = false;
  bool cancelled = false;

  @override
  bool get isSupported => true;

  @override
  Stream<double> get amplitudes => const Stream<double>.empty();

  @override
  Future<void> start() async => started = true;

  @override
  Future<RecordedVoice?> stop() async {
    stopped = true;
    return RecordedVoice(
      bytes: Uint8List.fromList([1, 2, 3]),
      contentType: 'audio/webm',
      durationMs: 1200,
    );
  }

  @override
  Future<void> cancel() async => cancelled = true;
}

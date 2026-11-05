import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/features/messaging/widgets/voice_wave.dart';

/// The recording waveform draws whatever 0..1 levels it is given and cleans up
/// after itself. It owns no recording logic, so a plain stream exercises it.
void main() {
  Widget host(Stream<double> levels) => MaterialApp(
    home: Scaffold(
      body: Center(
        child: SizedBox(width: 300, child: VoiceWave(levels: levels)),
      ),
    ),
  );

  testWidgets('renders the dot, a timer and a waveform', (tester) async {
    await tester.pumpWidget(host(const Stream<double>.empty()));
    expect(find.byType(VoiceWave), findsOneWidget);
    expect(find.byType(CustomPaint), findsWidgets);
    expect(find.text('00:00'), findsOneWidget);
  });

  testWidgets('updates as loudness samples arrive', (tester) async {
    final controller = StreamController<double>.broadcast();
    await tester.pumpWidget(host(controller.stream));
    controller
      ..add(0.2)
      ..add(0.9);
    await tester.pump();
    // A rebuild happened without error; the painter now has samples to draw.
    expect(tester.takeException(), isNull);
    expect(find.byType(VoiceWave), findsOneWidget);
    await controller.close();
  });

  testWidgets('cancels its subscription and timer on dispose', (tester) async {
    final controller = StreamController<double>.broadcast();
    await tester.pumpWidget(host(controller.stream));
    expect(controller.hasListener, isTrue);
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    expect(controller.hasListener, isFalse);
    await controller.close();
  });
}

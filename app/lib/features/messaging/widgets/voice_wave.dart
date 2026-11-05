import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';

/// The live recording indicator for a voice message: a blinking dot, the
/// elapsed time, and a bar waveform that rises and falls with the input
/// loudness. Purely presentational — it draws the 0..1 [levels] the recorder
/// reports and owns no recording logic, so it is the same on web and native and
/// is tested with a plain stream.
///
/// When the recorder reports nothing (an older build, or a platform that cannot
/// meter), the bars stay flat and only the dot and timer move — the recording
/// is unaffected.
class VoiceWave extends StatefulWidget {
  const VoiceWave({super.key, required this.levels, this.barCount = 34});

  /// The input loudness while recording, as 0..1 values (louder is higher).
  final Stream<double> levels;

  /// How many bars the waveform holds; older values scroll off the left.
  final int barCount;

  @override
  State<VoiceWave> createState() => _VoiceWaveState();
}

class _VoiceWaveState extends State<VoiceWave> {
  final List<double> _bars = <double>[];
  StreamSubscription<double>? _sub;
  final Stopwatch _elapsed = Stopwatch();
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _elapsed.start();
    // A one-second tick keeps the clock honest even while silence sends no
    // loudness samples.
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
    _subscribe();
  }

  @override
  void didUpdateWidget(VoiceWave oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.levels != widget.levels) _subscribe();
  }

  void _subscribe() {
    _sub?.cancel();
    _sub = widget.levels.listen((level) {
      if (!mounted) return;
      setState(() {
        _bars.add(level.clamp(0.0, 1.0));
        if (_bars.length > widget.barCount) {
          _bars.removeRange(0, _bars.length - widget.barCount);
        }
      });
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    _ticker?.cancel();
    _elapsed.stop();
    super.dispose();
  }

  String get _time {
    final s = _elapsed.elapsed.inSeconds;
    final mm = (s ~/ 60).toString().padLeft(2, '0');
    final ss = (s % 60).toString().padLeft(2, '0');
    return '$mm:$ss';
  }

  @override
  Widget build(BuildContext context) {
    final color = context.colors.error;
    // The bars are decorative; the label and the spoken time keep the
    // recording legible to a screen reader, as the old «جارٍ التسجيل…» text did.
    return Semantics(
      container: true,
      label: 'جارٍ التسجيل',
      value: _time,
      child: Row(
        children: [
          _BlinkingDot(color: color),
          const SizedBox(width: Insets.sm),
          SizedBox(
            width: 44,
            child: Text(
              _time,
              style: context.text.labelMedium?.copyWith(
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
          const SizedBox(width: Insets.sm),
          Expanded(
            child: SizedBox(
              height: 28,
              child: CustomPaint(
                painter: _WavePainter(
                  levels: List<double>.unmodifiable(_bars),
                  barCount: widget.barCount,
                  color: color,
                ),
                size: Size.infinite,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// A recording dot that fades in and out, so the surface reads as "live" even
/// in silence.
class _BlinkingDot extends StatefulWidget {
  const _BlinkingDot({required this.color});
  final Color color;

  @override
  State<_BlinkingDot> createState() => _BlinkingDotState();
}

class _BlinkingDotState extends State<_BlinkingDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
    opacity: Tween<double>(begin: 0.3, end: 1).animate(_c),
    child: Icon(
      Icons.fiber_manual_record_rounded,
      color: widget.color,
      size: 14,
    ),
  );
}

/// Draws the most recent [levels] as rounded vertical bars, newest on the
/// right. Bars yet to be filled (before enough samples arrive) read as the
/// quiet baseline, so the waveform grows in from the right rather than jumping.
class _WavePainter extends CustomPainter {
  _WavePainter({
    required this.levels,
    required this.barCount,
    required this.color,
  });

  final List<double> levels;
  final int barCount;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    if (barCount <= 0) return;
    const gap = 3.0;
    final barWidth = (size.width - gap * (barCount - 1)) / barCount;
    if (barWidth <= 0) return;
    final paint = Paint()..color = color;
    final mid = size.height / 2;
    final minH = size.height * 0.08;
    // Right-align the samples we have; missing older bars stay at the baseline.
    final offset = barCount - levels.length;
    for (var i = 0; i < barCount; i++) {
      final level = i >= offset ? levels[i - offset] : 0.0;
      final h = (minH + level * (size.height - minH)).clamp(minH, size.height);
      final x = i * (barWidth + gap);
      final rect = RRect.fromRectAndRadius(
        Rect.fromLTWH(x, mid - h / 2, barWidth, h),
        const Radius.circular(2),
      );
      canvas.drawRRect(rect, paint);
    }
  }

  @override
  bool shouldRepaint(_WavePainter old) =>
      old.levels != levels || old.color != color || old.barCount != barCount;
}

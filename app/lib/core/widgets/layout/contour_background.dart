import 'dart:math' as math;

import 'package:flutter/material.dart';

/// The institution profile repeats a motif of fine parallel contour curves
/// behind its headings. This paints the same idea rather than reproducing the
/// artwork: a family of offset sine curves at very low opacity.
class ContourPainter extends CustomPainter {
  const ContourPainter({
    required this.color,
    this.lines = 14,
    this.opacity = 0.10,
    this.amplitude = 26,
    this.phase = 0,
  });

  final Color color;
  final int lines;
  final double opacity;
  final double amplitude;
  final double phase;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.width <= 0 || size.height <= 0) return;

    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..strokeCap = StrokeCap.round;

    final gap = size.height / (lines + 1);

    for (var i = 1; i <= lines; i++) {
      final baseY = gap * i;
      // Curves fade towards the bottom of the band.
      final fade = 1 - (i / (lines + 1)) * 0.55;
      paint.color = color.withValues(alpha: opacity * fade);

      final path = Path();
      for (double x = 0; x <= size.width; x += 6) {
        final t = (x / size.width) * math.pi * 2;
        final y = baseY +
            math.sin(t + phase + i * 0.22) * amplitude * (i / lines) * 0.9;
        if (x == 0) {
          path.moveTo(x, y);
        } else {
          path.lineTo(x, y);
        }
      }
      canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(ContourPainter oldDelegate) =>
      oldDelegate.color != color ||
      oldDelegate.lines != lines ||
      oldDelegate.opacity != opacity ||
      oldDelegate.phase != phase;
}

/// Convenience wrapper: a coloured band with contour lines and content on top.
class ContourBand extends StatelessWidget {
  const ContourBand({
    super.key,
    required this.child,
    required this.background,
    this.lineColor,
    this.borderRadius,
    this.padding = EdgeInsets.zero,
    this.opacity = 0.10,
  });

  final Widget child;
  final Color background;
  final Color? lineColor;
  final BorderRadiusGeometry? borderRadius;
  final EdgeInsetsGeometry padding;
  final double opacity;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius:
          (borderRadius ?? BorderRadius.zero).resolve(Directionality.of(context)),
      child: DecoratedBox(
        decoration: BoxDecoration(color: background),
        child: CustomPaint(
          painter: ContourPainter(
            color: lineColor ?? Colors.white,
            opacity: opacity,
          ),
          child: Padding(padding: padding, child: child),
        ),
      ),
    );
  }
}

import 'dart:math' as math;

import 'package:flutter/material.dart';

/// A self-contained, painted golden-hour mosque scene for the Home hero
/// background — reproducing the reference's photographic mosque *composition*
/// (warm sky, central dome, flanking minarets, palms) without shipping or
/// downloading any image asset, and without any external dependency.
///
/// It is deliberately isolated so real photography can replace it in one line:
/// swap this widget for `Image.asset('assets/images/hero_mosque.jpg',
/// fit: BoxFit.cover)` (and register the asset in pubspec.yaml). Nothing else
/// in [HomeHero]'s layout depends on how the background is produced.
class HomeHeroBackdrop extends StatelessWidget {
  const HomeHeroBackdrop({super.key});

  @override
  Widget build(BuildContext context) {
    return const SizedBox.expand(
      child: CustomPaint(
        painter: _MosquePainter(),
        // Decorative only — the hero's text carries the accessible meaning.
        isComplex: true,
        willChange: false,
      ),
    );
  }
}

class _MosquePainter extends CustomPainter {
  const _MosquePainter();

  // Golden-hour palette (dusk blue → peach → gold), warm and serene.
  static const _skyTop = Color(0xFFBFD6DE);
  static const _skyMid = Color(0xFFF3CBA1);
  static const _skyLow = Color(0xFFF0B678);
  static const _skyHorizon = Color(0xFFEBA867);
  static const _sun = Color(0xFFFFF3D6);
  static const _mosque = Color(0xFFF4E9D4);
  static const _mosqueShade = Color(0x22A9814A);
  static const _trim = Color(0xFFD8BE8E);
  static const _palmColor = Color(0xFF6E5033);
  static const _ground = Color(0xFFE6B681);

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    final rect = Offset.zero & size;

    // ── Sky ──────────────────────────────────────────────────────────────
    canvas.drawRect(
      rect,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [_skyTop, _skyMid, _skyLow, _skyHorizon],
          stops: [0.0, 0.5, 0.82, 1.0],
        ).createShader(rect),
    );

    final groundY = h * 0.88;

    // ── Sun glow, low centre ─────────────────────────────────────────────
    final sunCenter = Offset(w * 0.44, groundY - h * 0.12);
    canvas.drawRect(
      rect,
      Paint()
        ..shader = RadialGradient(
          colors: [_sun.withValues(alpha: 0.9), _sun.withValues(alpha: 0.0)],
        ).createShader(Rect.fromCircle(center: sunCenter, radius: w * 0.55)),
    );

    // ── Ground / courtyard ───────────────────────────────────────────────
    canvas.drawRect(Rect.fromLTRB(0, groundY, w, h), Paint()..color = _ground);

    final fill = Paint()..color = _mosque;
    final shade = Paint()..color = _mosqueShade;
    final trim = Paint()..color = _trim;

    // ── Palms on the left ────────────────────────────────────────────────
    _palm(canvas, Offset(w * 0.15, groundY), h * 0.40);
    _palm(canvas, Offset(w * 0.075, groundY), h * 0.31);

    // ── Mosque, centred just right of the sun ────────────────────────────
    final cx = w * 0.47;
    final baseW = w * 0.50;
    final blockTop = groundY - h * 0.20;

    // Minarets flank the hall.
    _minaret(canvas, cx - baseW * 0.56, groundY, h * 0.56, w * 0.032, fill, trim);
    _minaret(canvas, cx + baseW * 0.56, groundY, h * 0.56, w * 0.032, fill, trim);

    // Prayer-hall block.
    final block = RRect.fromRectAndCorners(
      Rect.fromLTRB(cx - baseW / 2, blockTop, cx + baseW / 2, groundY),
      topLeft: const Radius.circular(6),
      topRight: const Radius.circular(6),
    );
    canvas.drawRRect(block, fill);
    // A soft shade on the left third gives the flat fill some depth.
    canvas.drawRect(
      Rect.fromLTRB(cx - baseW / 2, blockTop, cx - baseW * 0.16, groundY),
      shade,
    );

    // Flanking half-domes, then the central dome on its drum.
    _dome(canvas, cx - baseW * 0.30, blockTop, baseW * 0.24, h * 0.085, fill,
        trim);
    _dome(canvas, cx + baseW * 0.30, blockTop, baseW * 0.24, h * 0.085, fill,
        trim);

    final drumW = baseW * 0.30;
    final drumTop = blockTop - h * 0.045;
    canvas.drawRect(
      Rect.fromLTRB(cx - drumW / 2, drumTop, cx + drumW / 2, blockTop + 1),
      fill,
    );
    _dome(canvas, cx, drumTop, drumW * 1.12, h * 0.15, fill, trim);

    // A pointed-arch doorway grounds the hall.
    final doorW = baseW * 0.16, doorH = h * 0.11;
    final door = Path()
      ..moveTo(cx - doorW / 2, groundY)
      ..lineTo(cx - doorW / 2, groundY - doorH * 0.6)
      ..quadraticBezierTo(cx, groundY - doorH * 1.25, cx + doorW / 2,
          groundY - doorH * 0.6)
      ..lineTo(cx + doorW / 2, groundY)
      ..close();
    canvas.drawPath(door, shade);
  }

  /// A pointed onion dome sitting on [baseY], with a finial + crescent.
  void _dome(Canvas c, double cx, double baseY, double width, double height,
      Paint fill, Paint trim) {
    final hw = width / 2;
    final onion = Path()
      ..moveTo(cx - hw, baseY)
      ..cubicTo(cx - hw, baseY - height * 0.55, cx - hw * 0.55,
          baseY - height * 0.82, cx, baseY - height)
      ..cubicTo(cx + hw * 0.55, baseY - height * 0.82, cx + hw,
          baseY - height * 0.55, cx + hw, baseY)
      ..close();
    c.drawPath(onion, fill);
    // Finial stem + crescent.
    c.drawRect(
      Rect.fromLTWH(cx - width * 0.02, baseY - height - height * 0.14,
          width * 0.04, height * 0.16),
      trim,
    );
    _crescent(c, Offset(cx, baseY - height - height * 0.20), width * 0.10, trim);
  }

  /// A slender minaret: shaft, balcony ring, cap dome and crescent.
  void _minaret(Canvas c, double x, double baseY, double height, double width,
      Paint fill, Paint trim) {
    final topY = baseY - height;
    final shaftTop = topY + height * 0.20;
    c.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(x - width / 2, shaftTop, width, baseY - shaftTop),
        Radius.circular(width * 0.35),
      ),
      fill,
    );
    c.drawRect(
      Rect.fromLTWH(x - width * 0.85, topY + height * 0.24, width * 1.7,
          height * 0.018),
      trim,
    );
    _dome(c, x, shaftTop, width * 1.5, height * 0.17, fill, trim);
  }

  void _crescent(Canvas c, Offset center, double r, Paint paint) {
    final path = Path()
      ..addOval(Rect.fromCircle(center: center, radius: r))
      ..addOval(Rect.fromCircle(
          center: center.translate(r * 0.45, -r * 0.12), radius: r * 0.82))
      ..fillType = PathFillType.evenOdd;
    c.drawPath(path, paint);
  }

  /// A curved-trunk palm with radiating fronds — a warm silhouette.
  void _palm(Canvas c, Offset base, double height) {
    final top = Offset(base.dx + height * 0.05, base.dy - height);
    final trunk = Paint()
      ..color = _palmColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = math.max(2, height * 0.035)
      ..strokeCap = StrokeCap.round;
    c.drawPath(
      Path()
        ..moveTo(base.dx, base.dy)
        ..quadraticBezierTo(
            base.dx - height * 0.06, base.dy - height * 0.55, top.dx, top.dy),
      trunk,
    );
    final frond = Paint()
      ..color = _palmColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = math.max(1.5, height * 0.02)
      ..strokeCap = StrokeCap.round;
    for (var i = 0; i < 6; i++) {
      final a = math.pi * (0.15 + i * 0.14); // spread across the crown
      final dx = math.cos(a) * height * 0.34;
      final dy = math.sin(a) * height * 0.30;
      c.drawPath(
        Path()
          ..moveTo(top.dx, top.dy)
          ..quadraticBezierTo(top.dx - dx * 0.4, top.dy - dy * 0.55,
              top.dx - dx, top.dy - dy + height * 0.10),
        frond,
      );
    }
  }

  @override
  bool shouldRepaint(_MosquePainter oldDelegate) => false;
}

import 'package:flutter/widgets.dart';

/// Spacing, radii, shadows and durations.
///
/// The generous radii mirror the heavily rounded cards and pills of the
/// institution profile; the shadows are tinted plum rather than grey so they
/// stay inside the brand's colour world.
abstract final class Insets {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 20;
  static const double xxl = 24;
  static const double xxxl = 32;
  static const double huge = 40;
  static const double giant = 48;
}

abstract final class Radii {
  static const Radius sm = Radius.circular(8);
  static const Radius md = Radius.circular(12);
  static const Radius lg = Radius.circular(20);
  static const Radius xl = Radius.circular(28);

  static const BorderRadius brSm = BorderRadius.all(sm);
  static const BorderRadius brMd = BorderRadius.all(md);
  static const BorderRadius brLg = BorderRadius.all(lg);
  static const BorderRadius brXl = BorderRadius.all(xl);
  static const BorderRadius pill = BorderRadius.all(Radius.circular(999));
}

abstract final class Shadows {
  static const List<BoxShadow> card = [
    BoxShadow(
      color: Color(0x14721D49),
      blurRadius: 8,
      offset: Offset(0, 2),
    ),
  ];

  static const List<BoxShadow> raised = [
    BoxShadow(
      color: Color(0x1F721D49),
      blurRadius: 16,
      offset: Offset(0, 4),
    ),
  ];

  static const List<BoxShadow> sheet = [
    BoxShadow(
      color: Color(0x29721D49),
      blurRadius: 24,
      offset: Offset(0, 8),
    ),
  ];
}

abstract final class Motion {
  static const Duration page = Duration(milliseconds: 300);
  static const Duration card = Duration(milliseconds: 200);
  static const Duration sheet = Duration(milliseconds: 250);
  static const Duration progress = Duration(milliseconds: 600);
}

/// Layout breakpoints. The prototype is mobile-first; the wider layouts exist
/// so the same code can be reviewed comfortably in a desktop browser.
enum Breakpoint {
  mobile,
  tablet,
  desktop;

  static Breakpoint of(double width) {
    if (width >= 1024) return Breakpoint.desktop;
    if (width >= 600) return Breakpoint.tablet;
    return Breakpoint.mobile;
  }

  bool get isMobile => this == Breakpoint.mobile;
  bool get isDesktop => this == Breakpoint.desktop;

  double get gutter => switch (this) {
        Breakpoint.mobile => Insets.lg,
        Breakpoint.tablet => Insets.xxl,
        Breakpoint.desktop => Insets.xxxl,
      };

  double get maxContentWidth => switch (this) {
        Breakpoint.mobile => double.infinity,
        Breakpoint.tablet => 760,
        Breakpoint.desktop => 1100,
      };
}

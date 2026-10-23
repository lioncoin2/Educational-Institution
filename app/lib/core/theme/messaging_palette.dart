import 'package:flutter/material.dart';

import 'app_tokens.dart';

/// The institution's refined green/cream palette for the **messaging surface**
/// — the conversations list, every conversation (direct, group, channel), the
/// community info/management screens that share the chat design system, and
/// bulk publishing.
///
/// The app's GLOBAL theme is plum (`app_theme.dart`, `AppColors.primary`
/// `#8A4269`), kept for navigation and the rest of the app. Messaging wraps
/// itself in [themeOf] *below* the shared navigation shell, so the plum nav pill
/// and every non-messaging tab are untouched. This is the same scoping
/// technique Home and مساري use — but a DISTINCT, brighter palette: those
/// screens keep their own `#006B4F` emblem green (unchanged), while messaging
/// uses the owner-approved reference tokens below. The two are deliberately not
/// merged (different values).
///
/// Tokens (from the owner's design reference), centralized here as the single
/// source for the whole messaging surface — never hard-coded per widget:
///   primary               #0F7A5A  buttons, send, avatars, accents
///   secondary             #16A085  interactive highlights (non-text/large)
///   secondaryContainer    #E6F4EE  light-green surface, selected chips
///   surface               #F7FBFA  the conversation background
///   surfaceContainerLow   #F9F5E9  cream cards
///   surfaceContainerHigh  #E6F0ED  a received message bubble
///   primaryContainer      #D1E9E2  the viewer's own (sent) bubble
///
/// Message bubbles read `primaryContainer` (sent) and `surfaceContainerHigh`
/// (received) at paint time (message_bubble.dart), so mapping those two tokens
/// styles the bubbles with no widget change. Contrast of every text pairing is
/// asserted in `test/core/messaging_palette_test.dart`, and the rendered result
/// is captured as golden images in `test/messaging/golden/`.
abstract final class MessagingPalette {
  /// Wraps the ambient theme in the scoped green scheme.
  ///
  /// Several component themes bake scheme colours in at construction time in
  /// `app_theme.dart`, so a bare `colorScheme:` override would leave them plum.
  /// Those that appear on the messaging surface are re-themed here; everything
  /// else (filled/text buttons, the transparent app bar, cards) resolves its
  /// colour at paint time and follows the scheme automatically.
  static ThemeData themeOf(BuildContext context) {
    final base = Theme.of(context);
    final scheme = schemeOf(base.colorScheme);

    return base.copyWith(
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,
      dividerTheme: base.dividerTheme.copyWith(color: scheme.outlineVariant),
      progressIndicatorTheme: base.progressIndicatorTheme.copyWith(
        color: scheme.primary,
        linearTrackColor: scheme.surfaceContainerHighest,
        circularTrackColor: scheme.surfaceContainerHighest,
      ),
      // A secondary (outlined) button bakes its border from scheme.outline, so
      // override it to the green outline; its label already resolves primary.
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, 52),
          padding: const EdgeInsets.symmetric(horizontal: Insets.xxl),
          shape: const RoundedRectangleBorder(borderRadius: Radii.pill),
          side: BorderSide(color: scheme.primary),
          textStyle: base.textTheme.labelLarge,
        ),
      ),
      // Chips (e.g. the community list's الكل/المجموعات/القنوات filter) bake
      // their fill from scheme.surfaceContainer; keep it green-neutral, with the
      // light-green surface for the selected one.
      chipTheme: base.chipTheme.copyWith(
        backgroundColor: scheme.surfaceContainer,
        selectedColor: scheme.secondaryContainer,
        secondarySelectedColor: scheme.secondaryContainer,
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: const Size(0, 48),
          shape: const RoundedRectangleBorder(borderRadius: Radii.brMd),
          textStyle: base.textTheme.labelLarge,
        ),
      ),
    );
  }

  /// The green [ColorScheme] for the ambient brightness. Exposed so contrast can
  /// be asserted without pumping a widget.
  static ColorScheme schemeOf(ColorScheme base) =>
      base.brightness == Brightness.dark ? _dark(base) : _light(base);

  static ColorScheme _light(ColorScheme base) => base.copyWith(
        primary: const Color(0xFF0F7A5A), // 5.31:1 on white
        onPrimary: Colors.white,
        primaryContainer: const Color(0xFFD1E9E2), // sent bubble
        onPrimaryContainer: const Color(0xFF0A3D2E), // 8.9:1 on the sent bubble
        secondary: const Color(0xFF16A085), // accents (non-text/large)
        onSecondary: Colors.white,
        secondaryContainer: const Color(0xFFE6F4EE), // light-green surface
        onSecondaryContainer: const Color(0xFF0A3D2E),
        surface: const Color(0xFFF7FBFA), // conversation background
        surfaceContainerLowest: Colors.white,
        surfaceContainerLow: const Color(0xFFF9F5E9), // cream cards
        surfaceContainer: const Color(0xFFEAF4EF),
        surfaceContainerHigh: const Color(0xFFE6F0ED), // received bubble
        surfaceContainerHighest: const Color(0xFFDCEBE6),
        outline: const Color(0xFF7FB3A4),
        outlineVariant: const Color(0xFFCBE3DB),
      );

  static ColorScheme _dark(ColorScheme base) => base.copyWith(
        primary: const Color(0xFF4BBF99), // 6.0:1 on the dark surface
        onPrimary: const Color(0xFF00281D),
        primaryContainer: const Color(0xFF1E4A3C), // sent bubble (dark)
        onPrimaryContainer: const Color(0xFFCDEDE1),
        secondary: const Color(0xFF37B48F),
        onSecondary: const Color(0xFF00281D),
        secondaryContainer: const Color(0xFF22463B),
        onSecondaryContainer: const Color(0xFFCDEDE1),
        surface: const Color(0xFF0E1A16), // conversation background (dark)
        surfaceContainerLowest: const Color(0xFF0A1511),
        surfaceContainerLow: const Color(0xFF121F1A),
        surfaceContainer: const Color(0xFF16251F),
        surfaceContainerHigh: const Color(0xFF1C2E27), // received bubble (dark)
        surfaceContainerHighest: const Color(0xFF24382F),
        outline: const Color(0xFF3A5247),
        outlineVariant: const Color(0xFF2A3A33),
      );
}

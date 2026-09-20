import 'package:flutter/material.dart';

import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';
import 'responsive_body.dart';

/// The primary action pinned below a detail screen.
///
/// It paints a surface and a hairline so the scrolling content passes behind
/// it cleanly rather than showing through the button.
class BottomActionBar extends StatelessWidget {
  const BottomActionBar({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: context.colors.surface,
        border: Border(
          top: BorderSide(color: context.colors.outlineVariant),
        ),
      ),
      child: SafeArea(
        top: false,
        minimum: const EdgeInsets.only(
          top: Insets.md,
          bottom: Insets.md,
        ),
        child: ResponsiveBody(child: child),
      ),
    );
  }
}

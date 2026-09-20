import 'package:flutter/material.dart';

import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';

/// The one card in the app. Heavily rounded, plum-tinted shadow — the shape
/// language of the printed profile, translated to a screen.
class AppCard extends StatelessWidget {
  const AppCard({
    super.key,
    required this.child,
    this.onTap,
    this.padding = const EdgeInsets.all(Insets.lg),
    this.color,
    this.borderColor,
    this.borderRadius = Radii.brLg,
    this.elevated = false,
    this.semanticLabel,
  });

  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry padding;
  final Color? color;
  final Color? borderColor;
  final BorderRadius borderRadius;
  final bool elevated;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final body = Container(
      decoration: BoxDecoration(
        color: color ?? context.colors.surfaceContainerLowest,
        borderRadius: borderRadius,
        border: borderColor == null ? null : Border.all(color: borderColor!),
        boxShadow: context.isDark
            ? null
            : (elevated ? Shadows.raised : Shadows.card),
      ),
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: onTap,
          borderRadius: borderRadius,
          child: Padding(padding: padding, child: child),
        ),
      ),
    );

    return semanticLabel == null
        ? body
        : Semantics(label: semanticLabel, button: onTap != null, child: body);
  }
}

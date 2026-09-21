import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import 'path_palette.dart';

/// A soft pastel figure tile: icon chip, large number, small caption.
///
/// The tint carries provenance ([PathTileTone]), so a reader can separate
/// figures taken from the institution profile from prototype placeholders
/// without reading the chips.
class PathStatTile extends StatelessWidget {
  const PathStatTile({
    super.key,
    required this.icon,
    required this.value,
    required this.caption,
    required this.tone,
  });

  final IconData icon;
  final String value;
  final String caption;
  final PathTileTone tone;

  @override
  Widget build(BuildContext context) {
    final c = PathPalette.tile(context, tone);

    // One announcement per tile ("أقسام تعليمية: 5") instead of two loose
    // fragments.
    return Semantics(
      label: '$caption: $value',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.all(Insets.md),
        decoration: BoxDecoration(
          color: c.background,
          borderRadius: Radii.brLg,
        ),
        // mainAxisSize.min with no fixed height: the tile grows with the text
        // scale rather than clipping at 1.3.
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(Insets.sm),
              decoration: BoxDecoration(
                color: c.iconChip,
                borderRadius: Radii.brSm,
              ),
              child: Icon(icon, size: 18, color: c.foreground),
            ),
            const SizedBox(height: Insets.sm),
            Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.text.titleLarge?.copyWith(
                color: c.foreground,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              caption,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: context.text.labelSmall?.copyWith(color: c.foreground),
            ),
          ],
        ),
      ),
    );
  }
}

/// Two tiles side by side, equal height regardless of caption length.
///
/// IntrinsicHeight + stretch is required: under a sliver the row's height is
/// unbounded, and stretching an Expanded child in an unbounded row asserts.
class PathStatTilePair extends StatelessWidget {
  const PathStatTilePair({super.key, required this.start, required this.end});

  final Widget start;
  final Widget end;

  @override
  Widget build(BuildContext context) {
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(child: start),
          const SizedBox(width: Insets.sm),
          Expanded(child: end),
        ],
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import 'home_palette.dart';

/// One real figure on the Home stats card.
class HomeStat {
  const HomeStat({
    required this.icon,
    required this.value,
    required this.caption,
    required this.tone,
  });

  final IconData icon;
  final String value;
  final String caption;
  final HomeTileTone tone;
}

/// The reference's white stats container: a row of four soft pastel tiles,
/// each with a centred icon, a bold figure and a caption.
///
/// Every figure is real institution data (section, halaqa, field and
/// companion-program counts from the profile). The reference's own graduate and
/// student totals have no equivalent in our data and are deliberately not
/// shown; the pastel tints are purely decorative.
class HomeStatsCard extends StatelessWidget {
  const HomeStatsCard({super.key, required this.stats});

  final List<HomeStat> stats;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      color: context.colors.surfaceContainerLowest,
      borderRadius: Radii.brXl,
      padding: const EdgeInsets.all(Insets.md),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < stats.length; i++) ...[
              if (i > 0) const SizedBox(width: Insets.sm),
              Expanded(child: _Tile(stat: stats[i])),
            ],
          ],
        ),
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.stat});

  final HomeStat stat;

  @override
  Widget build(BuildContext context) {
    final c = HomePalette.tile(context, stat.tone);

    return Semantics(
      label: '${stat.caption}: ${stat.value}',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: Insets.xs,
          vertical: Insets.sm,
        ),
        decoration: BoxDecoration(
          color: c.background,
          borderRadius: Radii.brLg,
        ),
        // No fixed height: the tile grows with the text scale.
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(color: c.iconChip, shape: BoxShape.circle),
              child: Icon(stat.icon, size: 18, color: c.foreground),
            ),
            const SizedBox(height: Insets.xs),
            // FittedBox so a wide figure never overflows the quarter-width tile.
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                stat.value,
                maxLines: 1,
                style: context.text.titleLarge?.copyWith(
                  color: c.foreground,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
            const SizedBox(height: 2),
            Text(
              stat.caption,
              textAlign: TextAlign.center,
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

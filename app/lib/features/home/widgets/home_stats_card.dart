import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/mock_ribbon.dart';
import 'home_palette.dart';

/// One real figure the Home stats card presents.
class HomeStat {
  const HomeStat({
    required this.icon,
    required this.value,
    required this.caption,
    required this.tone,
    required this.sourcePage,
  });

  final IconData icon;
  final String value;
  final String caption;
  final HomeTileTone tone;
  final int sourcePage;
}

/// The reference's white stats container: a row of four soft pastel tiles.
///
/// Every figure is real institution data (department and companion-program
/// counts from the profile), so the card carries source chips and no mock
/// marker. The tints are purely decorative.
class HomeStatsCard extends StatelessWidget {
  const HomeStatsCard({super.key, required this.stats});

  final List<HomeStat> stats;

  @override
  Widget build(BuildContext context) {
    final pages = {for (final s in stats) s.sourcePage}.toList()..sort();

    return AppCard(
      color: context.colors.surfaceContainerLowest,
      borderRadius: Radii.brXl,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          IntrinsicHeight(
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
          const SizedBox(height: Insets.lg),
          Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.sm,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text('من الملف التعريفي', style: context.text.labelSmall),
              for (final page in pages) SourceChip(page: page),
            ],
          ),
        ],
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
        padding: const EdgeInsets.all(Insets.md),
        decoration: BoxDecoration(
          color: c.background,
          borderRadius: Radii.brLg,
        ),
        // No fixed height: the tile grows with the text scale.
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
              child: Icon(stat.icon, size: 18, color: c.foreground),
            ),
            const SizedBox(height: Insets.sm),
            // FittedBox so a wide number never overflows the quarter-width tile.
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: AlignmentDirectional.centerStart,
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

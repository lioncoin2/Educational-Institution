import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/patterns/program_icons.dart';
import '../../../data/models/program.dart';
import 'home_palette.dart';

/// The reference's category grid: soft pastel cards in a 3 + 2 arrangement.
///
/// The cards are the institution's five real departments (profile page 6) —
/// deliberately NOT the reference's invented categories. Each shows the real
/// halaqat count as its subtitle.
class HomeCategoryGrid extends StatelessWidget {
  const HomeCategoryGrid({
    super.key,
    required this.departments,
    required this.onOpen,
  });

  final List<Program> departments;
  final void Function(Program program) onOpen;

  static const _tones = [
    HomeTileTone.mint,
    HomeTileTone.sky,
    HomeTileTone.lavender,
    HomeTileTone.peach,
  ];

  @override
  Widget build(BuildContext context) {
    if (departments.isEmpty) return const SizedBox.shrink();

    // Reference layout: three per row, so a trailing gap falls at the row's
    // end (the left, under RTL) exactly as in the blueprint.
    final rows = <List<Program?>>[];
    for (var i = 0; i < departments.length; i += 3) {
      final row = <Program?>[
        for (var j = i; j < i + 3 && j < departments.length; j++)
          departments[j],
      ];
      while (row.length < 3) {
        row.add(null); // empty end slot keeps cards a third of the width
      }
      rows.add(row);
    }

    return Column(
      children: [
        for (var r = 0; r < rows.length; r++) ...[
          if (r > 0) const SizedBox(height: Insets.md),
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (var c = 0; c < rows[r].length; c++) ...[
                  if (c > 0) const SizedBox(width: Insets.md),
                  Expanded(
                    child: rows[r][c] == null
                        ? const SizedBox.shrink()
                        : _CategoryCard(
                            program: rows[r][c]!,
                            tone: _tones[
                                departments.indexOf(rows[r][c]!) % _tones.length],
                            onTap: () => onOpen(rows[r][c]!),
                          ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ],
    );
  }
}

class _CategoryCard extends StatelessWidget {
  const _CategoryCard({
    required this.program,
    required this.tone,
    required this.onTap,
  });

  final Program program;
  final HomeTileTone tone;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = HomePalette.tile(context, tone);

    // No semanticLabel on AppCard: its InkWell merges the subtree into one
    // node, and the child Texts already announce.
    return AppCard(
      onTap: onTap,
      color: c.background,
      padding: const EdgeInsets.all(Insets.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(Insets.sm),
            decoration: BoxDecoration(
              color: c.iconChip,
              borderRadius: Radii.brSm,
            ),
            child: Icon(
              programIcon(program.iconName),
              size: 20,
              color: c.foreground,
            ),
          ),
          const SizedBox(height: Insets.md),
          Text(
            program.name,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: context.text.titleSmall?.copyWith(color: c.foreground),
          ),
          if (program.halaqatCount != null) ...[
            const SizedBox(height: 2),
            Text(
              '${program.halaqatCount} حلقات',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              // Full-opacity foreground: a reduced alpha drops mint/peach below
              // the 4.5:1 AA floor. Hierarchy comes from the smaller type, and
              // this exact colour is covered by the palette contrast test.
              style: context.text.labelSmall?.copyWith(color: c.foreground),
            ),
          ],
        ],
      ),
    );
  }
}

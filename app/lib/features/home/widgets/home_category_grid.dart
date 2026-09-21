import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/patterns/program_icons.dart';
import '../../../data/models/program.dart';
import 'home_palette.dart';

/// The reference's category grid: soft pastel cards, three per row, each with a
/// centred icon, a coloured title and a caption. An incomplete final row is
/// centred, as in the blueprint.
///
/// The cards are the institution's five real departments (profile page 6) —
/// deliberately NOT the reference's invented categories. Each shows its real
/// halaqat count.
class HomeCategoryGrid extends StatelessWidget {
  const HomeCategoryGrid({
    super.key,
    required this.departments,
    required this.onOpen,
  });

  final List<Program> departments;
  final void Function(Program program) onOpen;

  static const _columns = 3;
  static const _gap = Insets.md;
  static const _tones = [
    HomeTileTone.peach,
    HomeTileTone.sky,
    HomeTileTone.mint,
    HomeTileTone.lavender,
  ];

  @override
  Widget build(BuildContext context) {
    if (departments.isEmpty) return const SizedBox.shrink();

    return LayoutBuilder(
      builder: (context, constraints) {
        final cardW =
            (constraints.maxWidth - _gap * (_columns - 1)) / _columns;

        final rows = <List<Program>>[];
        for (var i = 0; i < departments.length; i += _columns) {
          rows.add(departments.sublist(
              i, math.min(i + _columns, departments.length)));
        }

        return Column(
          children: [
            for (var r = 0; r < rows.length; r++) ...[
              if (r > 0) const SizedBox(height: _gap),
              IntrinsicHeight(
                child: Row(
                  // A full row fills the width; an incomplete final row centres.
                  mainAxisAlignment: rows[r].length == _columns
                      ? MainAxisAlignment.start
                      : MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (var c = 0; c < rows[r].length; c++) ...[
                      if (c > 0) const SizedBox(width: _gap),
                      SizedBox(
                        width: cardW,
                        child: _CategoryCard(
                          program: rows[r][c],
                          tone: _tones[
                              departments.indexOf(rows[r][c]) % _tones.length],
                          onTap: () => onOpen(rows[r][c]),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ],
        );
      },
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
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.sm,
        vertical: Insets.md,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(color: c.iconChip, shape: BoxShape.circle),
            child: Icon(programIcon(program.iconName), size: 22, color: c.foreground),
          ),
          const SizedBox(height: Insets.sm),
          Text(
            program.name,
            textAlign: TextAlign.center,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: context.text.titleSmall?.copyWith(
              color: c.foreground,
              fontWeight: FontWeight.w700,
            ),
          ),
          if (program.halaqatCount != null) ...[
            const SizedBox(height: 2),
            Text(
              '${program.halaqatCount} حلقة',
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              // Full-opacity foreground keeps mint/peach above the AA floor.
              style: context.text.labelSmall?.copyWith(color: c.foreground),
            ),
          ],
        ],
      ),
    );
  }
}

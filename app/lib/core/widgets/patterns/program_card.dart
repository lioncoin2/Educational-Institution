import 'package:flutter/material.dart';

import '../../../data/models/program.dart';
import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';
import '../foundations/app_card.dart';
import '../foundations/stat_badge.dart';
import 'program_icons.dart';

/// One program, department or section. Everything it shows comes from the
/// profile PDF, so it carries no mock chip.
class ProgramCard extends StatelessWidget {
  const ProgramCard({
    super.key,
    required this.program,
    this.onTap,
    this.trailing,
    this.showOrder = false,
  });

  final Program program;
  final VoidCallback? onTap;
  final Widget? trailing;
  final bool showOrder;

  @override
  Widget build(BuildContext context) {
    final badgeText = program.badge ??
        (program.halaqatCount != null
            ? '${program.halaqatCount} حلقات'
            : program.levelsCount != null
                ? '${program.levelsCount} مستويات'
                : program.capacityNote);

    return AppCard(
      onTap: onTap,
      semanticLabel: program.name,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Leading(program: program, showOrder: showOrder),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  program.name,
                  style: context.text.titleMedium,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                if (program.description != null) ...[
                  const SizedBox(height: Insets.xs),
                  Text(
                    program.description!,
                    style: context.text.bodySmall,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
                if (badgeText != null) ...[
                  const SizedBox(height: Insets.md),
                  Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: StatBadge(
                      label: badgeText,
                      tone: StatBadgeTone.soft,
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (trailing != null) ...[
            const SizedBox(width: Insets.sm),
            trailing!,
          ] else if (onTap != null) ...[
            const SizedBox(width: Insets.xs),
            Icon(
              Icons.chevron_right_rounded,
              color: context.colors.onSurfaceVariant,
            ),
          ],
        ],
      ),
    );
  }
}

class _Leading extends StatelessWidget {
  const _Leading({required this.program, required this.showOrder});

  final Program program;
  final bool showOrder;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 48,
      height: 48,
      decoration: BoxDecoration(
        color: context.colors.primaryContainer,
        borderRadius: Radii.brMd,
      ),
      alignment: Alignment.center,
      child: showOrder && program.order > 0
          ? Text(
              '${program.order}',
              style: context.text.titleMedium?.copyWith(
                color: context.colors.onPrimaryContainer,
                fontWeight: FontWeight.w800,
              ),
            )
          : Icon(
              programIcon(program.iconName),
              color: context.colors.onPrimaryContainer,
              size: 24,
            ),
    );
  }
}

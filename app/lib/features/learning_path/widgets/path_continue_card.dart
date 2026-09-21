import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/mock_ribbon.dart';
import '../../../core/widgets/foundations/progress_indicators.dart';
import '../../../core/widgets/foundations/stat_badge.dart';
import '../../../data/models/learning.dart';

/// The featured "continue learning" card: where the learner is on the graded
/// path right now, and the one action that resumes it.
///
/// Note there is deliberately no `semanticLabel` on the [AppCard]. AppCard
/// wraps a semanticLabel in Semantics without `excludeSemantics`, so supplying
/// one would make a screen reader announce the composed label *and* every child
/// again.
class PathContinueCard extends StatelessWidget {
  const PathContinueCard({
    super.key,
    required this.step,
    required this.halaqa,
    required this.onOpen,
  });

  /// The rung of the graded path the learner currently stands on. Its name and
  /// halaqat count come from the profile; the position is prototype data.
  final PathStep step;

  /// The halaqa surfaced as "next" — prototype data.
  final Halaqa halaqa;

  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      elevated: true,
      borderRadius: Radii.brXl,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Three chips need two runs at the largest text scale on a phone.
          const Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.sm,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              StatBadge(
                label: 'القسم الحالي',
                icon: Icons.school_outlined,
                tone: StatBadgeTone.soft,
              ),
              SourceChip(page: 6),
              MockChip(compact: true),
            ],
          ),
          const SizedBox(height: Insets.lg),
          Text(step.name, style: context.text.titleLarge),
          const SizedBox(height: Insets.xs),
          Text(halaqa.name, style: context.text.bodyMedium),
          const SizedBox(height: Insets.lg),

          Row(
            children: [
              Semantics(
                label: 'أتممتِ ${step.completedHalaqat} من '
                    '${step.halaqatCount} حلقة في هذا القسم',
                excludeSemantics: true,
                child: AppProgressRing(
                  value: step.ratio,
                  centerTop: '${step.completedHalaqat}',
                  centerBottom: 'من ${step.halaqatCount}',
                  size: 96,
                  strokeWidth: 9,
                ),
              ),
              const SizedBox(width: Insets.xl),
              Expanded(
                child: AppProgressBar(
                  value: halaqa.ratio,
                  label: 'دروس الحلقة',
                  trailingLabel:
                      '${halaqa.completedLessons} من ${halaqa.lessons.length}',
                ),
              ),
            ],
          ),

          const SizedBox(height: Insets.lg),
          _MetaRow(halaqa: halaqa),
          const SizedBox(height: Insets.xl),

          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: onOpen,
              icon: const Icon(Icons.chevron_right_rounded),
              label: const Text(
                'ادخلي الحلقة',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Teacher and schedule, wrapped and width-bounded so a long label ellipsises
/// instead of overflowing.
class _MetaRow extends StatelessWidget {
  const _MetaRow({required this.halaqa});

  final Halaqa halaqa;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) => Wrap(
        spacing: Insets.lg,
        runSpacing: Insets.sm,
        children: [
          _MetaItem(
            icon: Icons.person_outline_rounded,
            label: halaqa.teacherName,
            maxWidth: constraints.maxWidth,
          ),
          _MetaItem(
            icon: Icons.schedule_rounded,
            label: halaqa.scheduleLabel,
            maxWidth: constraints.maxWidth,
          ),
        ],
      ),
    );
  }
}

class _MetaItem extends StatelessWidget {
  const _MetaItem({
    required this.icon,
    required this.label,
    required this.maxWidth,
  });

  final IconData icon;
  final String label;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    // A Wrap hands its children unbounded width, so Flexible alone would not
    // constrain the text — the bound has to come from the parent's constraints.
    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: maxWidth),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: context.colors.onSurfaceVariant),
          const SizedBox(width: Insets.xs),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.text.labelMedium,
            ),
          ),
        ],
      ),
    );
  }
}

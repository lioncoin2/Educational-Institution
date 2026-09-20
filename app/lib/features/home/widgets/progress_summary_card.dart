import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/mock_ribbon.dart';
import '../../../core/widgets/foundations/progress_indicators.dart';
import '../../../data/models/progress.dart';

/// Compact standing: ajzaa ring plus halaqat and attendance.
class ProgressSummaryCard extends StatelessWidget {
  const ProgressSummaryCard({
    super.key,
    required this.progress,
    required this.onTap,
  });

  final ProgressSummary progress;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      onTap: onTap,
      semanticLabel: 'ملخّص تقدّمك',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('تقدّمك', style: context.text.titleMedium),
              const SizedBox(width: Insets.sm),
              const Flexible(child: MockChip(compact: true)),
              const Spacer(),
              Icon(Icons.chevron_right_rounded,
                  color: context.colors.onSurfaceVariant),
            ],
          ),
          const SizedBox(height: Insets.lg),
          Row(
            children: [
              AppProgressRing(
                value: progress.juzRatio,
                centerTop: '${progress.memorisedJuz.length}',
                centerBottom: 'من ${progress.totalJuz} جزء',
                size: 96,
                strokeWidth: 9,
              ),
              const SizedBox(width: Insets.xl),
              Expanded(
                child: Column(
                  children: [
                    AppProgressBar(
                      value: progress.halaqatRatio,
                      label: 'الحلقات',
                      trailingLabel:
                          '${progress.completedHalaqat} / ${progress.totalHalaqat}',
                    ),
                    const SizedBox(height: Insets.lg),
                    AppProgressBar(
                      value: progress.attendanceRatio,
                      label: 'الحضور',
                      trailingLabel:
                          '${(progress.attendanceRatio * 100).round()}%',
                      color: context.colors.tertiary,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

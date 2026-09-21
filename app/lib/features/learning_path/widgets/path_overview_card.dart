import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/async_view.dart';
import '../../../core/widgets/foundations/mock_ribbon.dart';
import '../../../core/widgets/foundations/section_header.dart';
import '../../../data/models/progress.dart';
import '../../../data/sources/profile_data.dart';
import 'path_palette.dart';
import 'path_stat_tile.dart';

/// The white overview card: the graded-curriculum blurb from the profile, then
/// four figures split into a profile-sourced pair and a prototype pair.
///
/// The split is structural, not cosmetic — a divider and a labelled [MockChip]
/// separate the two pairs, and the tints reinforce it, so no reader can mistake
/// a placeholder for an institution figure.
class PathOverviewCard extends StatelessWidget {
  const PathOverviewCard({super.key, required this.progress});

  final AsyncValue<ProgressSummary> progress;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      color: context.colors.surfaceContainerLowest,
      borderRadius: Radii.brXl,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const CardTitleRow(
            title: 'المنهج المتدرّج',
            trailing: SourceChip(page: 6),
          ),
          const SizedBox(height: Insets.md),
          Text(ProfileData.departmentsIntro, style: context.text.bodyMedium),
          const SizedBox(height: Insets.lg),

          // ── Figures taken from the institution profile ──────────────────
          PathStatTilePair(
            start: PathStatTile(
              icon: Icons.layers_outlined,
              value: '${ProfileData.departments.length}',
              caption: 'أقسام تعليمية',
              tone: PathTileTone.profile,
            ),
            end: PathStatTile(
              icon: Icons.groups_2_outlined,
              value: '${ProfileData.totalHalaqat}',
              caption: 'حلقة في المسار',
              tone: PathTileTone.profile,
            ),
          ),

          const Padding(
            padding: EdgeInsets.symmetric(vertical: Insets.lg),
            child: Divider(),
          ),

          Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.sm,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text('موقعك على المسار', style: context.text.labelLarge),
              const MockChip(compact: true),
            ],
          ),
          const SizedBox(height: Insets.md),

          // ── Prototype figures ──────────────────────────────────────────
          AsyncView(
            value: progress,
            loading: const SkeletonBox(height: 104),
            builder: (context, data) => PathStatTilePair(
              start: PathStatTile(
                icon: Icons.check_circle_outline_rounded,
                value: '${data.completedHalaqat}',
                caption: 'حلقة مُتمّة',
                tone: PathTileTone.mock,
              ),
              end: PathStatTile(
                icon: Icons.how_to_reg_outlined,
                value: '${(data.attendanceRatio * 100).round()}%',
                caption: 'نسبة الحضور',
                tone: PathTileTone.mock,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/foundations/progress_indicators.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/foundations/stat_badge.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/patterns/juz_grid.dart';
import '../../data/models/progress.dart';
import '../../providers/app_providers.dart';

/// Cumulative standing. Deliberately self-referential: there is no ranking,
/// no comparison with other learners and no streak pressure. When nothing is
/// recorded (the real backend, for now) it says so instead of drawing zeros.
class ProgressScreen extends ConsumerWidget {
  const ProgressScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final progress = ref.watch(progressProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('تقدّمي')),
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: progress,
          loading: const Center(child: CircularProgressIndicator()),
          builder: (context, data) => data == null
              ? const _NothingRecorded()
              : CustomScrollView(
                  slivers: [
                    SliverGutter(child: _Headline(progress: data)),

                    SliverGutter(
                      top: Insets.xl,
                      child: const MockBanner(
                        message:
                            'الهياكل حقيقية من الملف التعريفي: 30 جزءاً في مدينة '
                            'الحفاظ، 45 حلقة في الأقسام الخمسة، والمتون الثلاثة. '
                            'أما الأرقام والنِسَب فبيانات تجريبية.',
                      ),
                    ),

                    // ── مدينة الحفاظ ──────────────────────────────────────────
                    SliverGutter(
                      top: Insets.xxl,
                      child: const SectionHeader(
                        title: 'مدينة الحفاظ',
                        subtitle: 'ثلاثون جزءاً',
                        trailing: SourceChip(page: 10),
                      ),
                    ),
                    SliverGutter(
                      top: Insets.lg,
                      child: AppCard(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Flexible(
                                  child: StatBadge(
                                    label:
                                        '${data.memorisedJuz.length} من ${data.totalJuz}',
                                    icon: Icons.auto_stories_outlined,
                                  ),
                                ),
                                const SizedBox(width: Insets.sm),
                                Text(
                                  '${(data.juzRatio * 100).round()}%',
                                  style: context.text.titleMedium?.copyWith(
                                    color: context.colors.primary,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: Insets.lg),
                            JuzGrid(
                              memorised: data.memorisedJuz,
                              total: data.totalJuz,
                            ),
                          ],
                        ),
                      ),
                    ),

                    // ── المتون ───────────────────────────────────────────────
                    SliverGutter(
                      top: Insets.xxl,
                      child: const SectionHeader(
                        title: 'المتون',
                        subtitle: 'تحفة الأطفال · الجزرية · الشاطبية',
                        trailing: SourceChip(page: 10),
                      ),
                    ),
                    SliverGutter(
                      top: Insets.lg,
                      child: AppCard(
                        child: Column(
                          children: [
                            for (var i = 0; i < data.mutun.length; i++) ...[
                              if (i > 0) const SizedBox(height: Insets.xl),
                              _MatnRow(matn: data.mutun[i]),
                            ],
                          ],
                        ),
                      ),
                    ),

                    // ── آخر النشاط ───────────────────────────────────────────
                    SliverGutter(
                      top: Insets.xxl,
                      child: const SectionHeader(title: 'آخر النشاط'),
                    ),
                    SliverGutter(
                      top: Insets.lg,
                      bottom: Insets.giant,
                      child: Column(
                        children: [
                          for (final entry in data.recentActivity)
                            Padding(
                              padding: const EdgeInsets.only(bottom: Insets.md),
                              child: _ActivityRow(entry: entry),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _Headline extends StatelessWidget {
  const _Headline({required this.progress});

  final ProgressSummary progress;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      elevated: true,
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      progress.studentName,
                      style: context.text.headlineMedium,
                    ),
                    const SizedBox(height: Insets.xs),
                    Text(
                      progress.currentProgramName,
                      style: context.text.bodyMedium,
                    ),
                    const SizedBox(height: Insets.md),
                    const MockChip(compact: true),
                  ],
                ),
              ),
              AppProgressRing(
                value: progress.halaqatRatio,
                centerTop: '${(progress.halaqatRatio * 100).round()}%',
                centerBottom: 'من المسار',
                size: 104,
                strokeWidth: 10,
              ),
            ],
          ),
          const SizedBox(height: Insets.xl),
          AppProgressBar(
            value: progress.halaqatRatio,
            label: 'الحلقات المكتملة',
            trailingLabel:
                '${progress.completedHalaqat} من ${progress.totalHalaqat}',
            height: 10,
          ),
          const SizedBox(height: Insets.lg),
          AppProgressBar(
            value: progress.attendanceRatio,
            label: 'نسبة الحضور',
            trailingLabel: '${(progress.attendanceRatio * 100).round()}%',
            color: context.colors.tertiary,
            height: 10,
          ),
        ],
      ),
    );
  }
}

class _MatnRow extends StatelessWidget {
  const _MatnRow({required this.matn});

  final MatnProgress matn;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: Text(matn.name, style: context.text.titleSmall)),
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: Insets.md,
                vertical: 2,
              ),
              decoration: BoxDecoration(
                color: matn.started
                    ? context.colors.primaryContainer
                    : context.colors.surfaceContainerHigh,
                borderRadius: Radii.pill,
              ),
              child: Text(
                matn.statusLabel,
                style: context.text.labelSmall?.copyWith(
                  color: matn.started
                      ? context.colors.onPrimaryContainer
                      : context.colors.onSurfaceVariant,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: Insets.md),
        AppProgressBar(value: matn.ratio),
      ],
    );
  }
}

class _ActivityRow extends StatelessWidget {
  const _ActivityRow({required this.entry});

  final ActivityEntry entry;

  @override
  Widget build(BuildContext context) {
    final icon = switch (entry.kind) {
      ActivityKind.lesson => Icons.play_lesson_outlined,
      ActivityKind.attendance => Icons.how_to_reg_outlined,
      ActivityKind.certificate => Icons.workspace_premium_outlined,
      ActivityKind.halaqa => Icons.groups_2_outlined,
    };

    return AppCard(
      padding: const EdgeInsets.all(Insets.md),
      color: context.colors.surfaceContainerLow,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: context.colors.primaryContainer,
              borderRadius: Radii.brSm,
            ),
            child: Icon(
              icon,
              size: 18,
              color: context.colors.onPrimaryContainer,
            ),
          ),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(entry.title, style: context.text.titleSmall),
                const SizedBox(height: 2),
                Text(entry.detail, style: context.text.bodySmall),
              ],
            ),
          ),
          const SizedBox(width: Insets.sm),
          Text(entry.dateLabel, style: context.text.labelSmall),
        ],
      ),
    );
  }
}

class _NothingRecorded extends StatelessWidget {
  const _NothingRecorded();

  @override
  Widget build(BuildContext context) {
    return const EmptyState(
      icon: Icons.insights_rounded,
      title: 'لا يوجد تقدّم مسجَّل بعد',
      message: 'لم يُسجَّل لكِ حضور أو إنجاز في الحلقات حتى الآن.',
    );
  }
}

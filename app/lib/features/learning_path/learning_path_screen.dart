import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/foundations/stat_badge.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/patterns/path_stepper.dart';
import '../../data/sources/profile_data.dart';
import '../../providers/app_providers.dart';

/// The graded ladder: the five departments of page 6, in the order the profile
/// lists them, with the learner's position marked.
class LearningPathScreen extends ConsumerWidget {
  const LearningPathScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final path = ref.watch(pathProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('مساري التعليمي'),
        automaticallyImplyLeading: false,
        actions: [
          IconButton(
            tooltip: 'تقدّمي',
            onPressed: () => context.push(Routes.progress),
            icon: const Icon(Icons.insights_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: SafeArea(
        top: false,
        child: CustomScrollView(
          slivers: [
            SliverGutter(
              child: AppCard(
                color: context.colors.surfaceContainerLow,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const CardTitleRow(
                      title: 'المنهج المتدرّج',
                      trailing: SourceChip(page: 6),
                    ),
                    const SizedBox(height: Insets.md),
                    Text(
                      ProfileData.departmentsIntro,
                      style: context.text.bodyMedium,
                    ),
                    const SizedBox(height: Insets.lg),
                    Wrap(
                      spacing: Insets.sm,
                      runSpacing: Insets.sm,
                      children: [
                        StatBadge(
                          label: '${ProfileData.departments.length} أقسام',
                          icon: Icons.layers_outlined,
                          tone: StatBadgeTone.soft,
                        ),
                        StatBadge(
                          label: '${ProfileData.totalHalaqat} حلقة',
                          icon: Icons.groups_2_outlined,
                          tone: StatBadgeTone.soft,
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),

            SliverGutter(
              top: Insets.xl,
              child: const MockBanner(
                message:
                    'ترتيب الأقسام وعدد حلقاتها مأخوذان من الملف التعريفي. '
                    'موقعك على المسار ونِسَب الإنجاز بيانات تجريبية.',
              ),
            ),

            SliverGutter(
              top: Insets.xl,
              child: AsyncView(
                value: path,
                loading: const SkeletonBox(height: 420),
                builder: (context, steps) => PathStepper(
                  steps: steps,
                  onStepTap: (step) => context.go(Routes.levels(step.programId)),
                ),
              ),
            ),

            const SliverToBoxAdapter(child: SizedBox(height: Insets.giant)),
          ],
        ),
      ),
    );
  }
}

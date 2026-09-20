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
import '../../core/widgets/patterns/program_card.dart';
import '../../data/sources/profile_data.dart';
import '../../providers/app_providers.dart';

/// Everything the institution offers, in one scannable screen.
/// All content here is from the profile PDF — hence no mock chips.
class ProgramsScreen extends ConsumerWidget {
  const ProgramsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final departments = ref.watch(departmentsProvider);
    final sections = ref.watch(specialSectionsProvider);
    final companions = ref.watch(companionProgramsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('البرامج والأقسام'),
        automaticallyImplyLeading: false,
      ),
      body: SafeArea(
        top: false,
        child: CustomScrollView(
          slivers: [
            SliverGutter(
              child: Text(
                ProfileData.departmentsIntro,
                style: context.text.bodyMedium,
              ),
            ),

            // ── الأقسام التعليمية الخمسة ────────────────────────────────
            SliverGutter(
              top: Insets.xxl,
              child: const SectionHeader(
                title: 'الأقسام التعليمية',
                subtitle: 'خمسة أقسام متدرّجة · 45 حلقة',
                trailing: SourceChip(page: 6),
              ),
            ),
            SliverGutter(
              top: Insets.lg,
              child: AsyncView(
                value: departments,
                loading: const SkeletonBox(height: 300),
                builder: (context, list) => Column(
                  children: [
                    for (final program in list)
                      Padding(
                        padding: const EdgeInsets.only(bottom: Insets.md),
                        child: ProgramCard(
                          program: program,
                          showOrder: true,
                          onTap: () => context.go(Routes.program(program.id)),
                        ),
                      ),
                  ],
                ),
              ),
            ),

            // ── أقسام خاصة ─────────────────────────────────────────────
            SliverGutter(
              top: Insets.xl,
              child: const SectionHeader(
                title: 'أقسام خاصة',
                subtitle: 'التهجي · البراعم · اللغات',
              ),
            ),
            SliverGutter(
              top: Insets.lg,
              child: AsyncView(
                value: sections,
                loading: const SkeletonBox(height: 220),
                builder: (context, list) => Column(
                  children: [
                    for (final program in list)
                      Padding(
                        padding: const EdgeInsets.only(bottom: Insets.md),
                        child: ProgramCard(
                          program: program,
                          onTap: () => context.go(Routes.program(program.id)),
                        ),
                      ),
                  ],
                ),
              ),
            ),

            // ── البرامج المرافقة ───────────────────────────────────────
            SliverGutter(
              top: Insets.xl,
              child: const SectionHeader(
                title: 'البرامج المرافقة',
                trailing: SourceChip(page: 10),
              ),
            ),
            SliverGutter(
              top: Insets.lg,
              child: AsyncView(
                value: companions,
                loading: const SkeletonBox(height: 240),
                builder: (context, list) => Column(
                  children: [
                    for (final program in list)
                      Padding(
                        padding: const EdgeInsets.only(bottom: Insets.md),
                        child: ProgramCard(
                          program: program,
                          onTap: () => context.go(Routes.program(program.id)),
                        ),
                      ),
                  ],
                ),
              ),
            ),

            // ── مجالات التعليم والتخصص ─────────────────────────────────
            SliverGutter(
              top: Insets.xl,
              child: const SectionHeader(
                title: 'مجالات التعليم والتخصص',
                trailing: SourceChip(page: 5),
              ),
            ),
            SliverGutter(
              top: Insets.lg,
              child: Wrap(
                spacing: Insets.md,
                runSpacing: Insets.md,
                children: [
                  for (final field in ProfileData.studyFields)
                    AppPill(label: field.name),
                ],
              ),
            ),

            // ── فجوة موثَّقة في الملف المصدر ───────────────────────────
            SliverGutter(top: Insets.xl, child: const _SourceGapCard()),

            const SliverToBoxAdapter(child: SizedBox(height: Insets.giant)),
          ],
        ),
      ),
    );
  }
}

/// Two items appear in the profile's table of contents (page 2) but have no
/// detail page. The prototype says so rather than inventing their content.
class _SourceGapCard extends StatelessWidget {
  const _SourceGapCard();

  @override
  Widget build(BuildContext context) {
    return AppCard(
      color: context.colors.surfaceContainerLow,
      borderColor: context.colors.outlineVariant,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.info_outline_rounded,
                  size: 18, color: context.colors.onSurfaceVariant),
              const SizedBox(width: Insets.sm),
              Expanded(
                child: Text('بانتظار محتوى من المؤسسة',
                    style: context.text.titleSmall),
              ),
            ],
          ),
          const SizedBox(height: Insets.md),
          Text(
            'هذان القسمان مذكوران في فهرس الملف التعريفي (ص2) لكن بلا صفحة '
            'تفصيلية، فلم يُوضع لهما محتوى:',
            style: context.text.bodySmall,
          ),
          const SizedBox(height: Insets.md),
          Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.sm,
            children: [
              for (final gap in ProfileData.documentedGaps)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: Insets.md,
                    vertical: Insets.sm,
                  ),
                  decoration: BoxDecoration(
                    borderRadius: Radii.pill,
                    border: Border.all(color: context.colors.outlineVariant),
                  ),
                  child: Text(gap, style: context.text.labelMedium),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

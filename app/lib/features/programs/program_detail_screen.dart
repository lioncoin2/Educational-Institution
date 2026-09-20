import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/layout/bottom_action_bar.dart';
import '../../core/widgets/layout/contour_background.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../core/widgets/patterns/info_row.dart';
import '../../core/widgets/patterns/program_icons.dart';
import '../../data/models/program.dart';
import '../../providers/app_providers.dart';

/// Everything the profile says about one program, plus the way into its levels.
class ProgramDetailScreen extends ConsumerWidget {
  const ProgramDetailScreen({super.key, required this.programId});

  final String programId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final program = ref.watch(programProvider(programId));

    return AsyncView(
      value: program,
      loading: const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      ),
      builder: (context, data) {
        if (data == null) {
          return Scaffold(
            appBar: AppBar(title: const Text('القسم')),
            body: const EmptyState(
              icon: Icons.search_off_rounded,
              title: 'لم نجد هذا القسم',
            ),
          );
        }
        return _Body(program: data);
      },
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.program});

  final Program program;

  bool get _hasLevels =>
      (program.halaqatCount ?? 0) > 0 || (program.levelsCount ?? 0) > 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(program.name)),
      body: SafeArea(
        top: false,
        child: CustomScrollView(
          slivers: [
            SliverToBoxAdapter(child: _Hero(program: program)),

            if (program.description != null)
              SliverGutter(
                top: Insets.xxl,
                child: AppCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      CardTitleRow(
                        title: 'عن القسم',
                        trailing: SourceChip(page: program.sourcePage),
                      ),
                      const SizedBox(height: Insets.md),
                      Text(
                        program.description!,
                        style: context.text.bodyLarge,
                      ),
                    ],
                  ),
                ),
              ),

            if (program.items.isNotEmpty)
              SliverGutter(
                top: Insets.xxl,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SectionHeader(
                      title: _itemsTitle(program),
                      trailing: SourceChip(page: program.sourcePage),
                    ),
                    const SizedBox(height: Insets.lg),
                    AppCard(child: BulletList(items: program.items)),
                  ],
                ),
              ),

            SliverGutter(
              top: Insets.xxl,
              child: AppCard(
                color: context.colors.surfaceContainerLow,
                child: Column(
                  children: [
                    if (program.halaqatCount != null)
                      InfoRow(
                        icon: Icons.groups_2_outlined,
                        label: 'عدد الحلقات',
                        value: '${program.halaqatCount} حلقات',
                      ),
                    if (program.levelsCount != null)
                      InfoRow(
                        icon: Icons.stairs_outlined,
                        label: 'المستويات',
                        value: '${program.levelsCount} مستويات',
                      ),
                    if (program.capacityNote != null)
                      InfoRow(
                        icon: Icons.people_outline_rounded,
                        label: 'السعة',
                        value: program.capacityNote!,
                      ),
                    InfoRow(
                      icon: Icons.payments_outlined,
                      label: 'الرسوم',
                      value: 'مجاني بالكامل',
                    ),
                    InfoRow(
                      icon: Icons.public_rounded,
                      label: 'نمط الدراسة',
                      value: 'عن بُعد',
                    ),
                  ],
                ),
              ),
            ),

            // Clearance for the pinned BottomActionBar.
            const SliverToBoxAdapter(child: SizedBox(height: 96)),
          ],
        ),
      ),
      bottomNavigationBar: BottomActionBar(
        child: _hasLevels
            ? FilledButton.icon(
                onPressed: () => context.go(Routes.levels(program.id)),
                icon: const Icon(Icons.stairs_rounded),
                label: const Text('عرض المسار والمستويات'),
              )
            : OutlinedButton.icon(
                onPressed: () => context.toast(
                  'لم يرد في الملف التعريفي تفصيل مستويات هذا البرنامج',
                ),
                icon: const Icon(Icons.info_outline_rounded),
                label: const Text('لا توجد مستويات مذكورة في الملف'),
              ),
      ),
    );
  }

  static String _itemsTitle(Program program) => switch (program.id) {
        'sec-spelling' => 'مراحل القسم',
        'sec-languages' => 'اللغات',
        'prog-mutun' => 'المتون',
        _ => 'المحاور',
      };
}

class _Hero extends StatelessWidget {
  const _Hero({required this.program});

  final Program program;

  @override
  Widget build(BuildContext context) {
    final badges = <String>[
      if (program.halaqatCount != null) '${program.halaqatCount} حلقات',
      if (program.levelsCount != null) '${program.levelsCount} مستويات',
      if (program.capacityNote != null) program.capacityNote!,
      if (program.badge != null && program.items.isEmpty) program.badge!,
    ];

    final onBrand = context.colors.onPrimary;

    return ContourBand(
      background: context.colors.primary,
      lineColor: onBrand,
      opacity: 0.14,
      borderRadius: const BorderRadius.vertical(bottom: Radii.xl),
      padding: const EdgeInsets.only(top: Insets.sm, bottom: Insets.xxl),
      child: ResponsiveBody(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 56,
                  height: 56,
                  decoration: BoxDecoration(
                    color: onBrand.withValues(alpha: 0.18),
                    borderRadius: Radii.brMd,
                  ),
                  child: Icon(
                    programIcon(program.iconName),
                    color: onBrand,
                    size: 28,
                  ),
                ),
                const SizedBox(width: Insets.md),
                Expanded(
                  child: Text(
                    program.name,
                    style:
                        context.text.headlineMedium?.copyWith(color: onBrand),
                  ),
                ),
              ],
            ),
            if (badges.isNotEmpty) ...[
              const SizedBox(height: Insets.lg),
              Wrap(
                spacing: Insets.sm,
                runSpacing: Insets.sm,
                children: [
                  for (final badge in badges)
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: Insets.md,
                        vertical: Insets.sm,
                      ),
                      decoration: BoxDecoration(
                        color: onBrand.withValues(alpha: 0.18),
                        borderRadius: Radii.brMd,
                      ),
                      child: Text(
                        badge,
                        style: context.text.labelMedium?.copyWith(
                          color: onBrand,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

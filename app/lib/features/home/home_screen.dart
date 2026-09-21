import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../data/models/program.dart';
import '../../providers/app_providers.dart';
import 'widgets/home_category_grid.dart';
import 'widgets/home_featured_card.dart';
import 'widgets/home_header.dart';
import 'widgets/home_hero.dart';
import 'widgets/home_palette.dart';
import 'widgets/home_stats_card.dart';

/// The home landing screen: institution identity, a personal greeting hero,
/// key figures, the department grid, and a featured section.
///
/// Home wears the institution's emblem green rather than the app's plum, via a
/// [HomePalette] Theme wrapper applied here — below the shared navigation
/// shell, so no other tab is affected and the bottom-nav pill stays plum. Every
/// figure shown is real profile data except the greeting cluster, which is the
/// placeholder learner and is marked with a mock chip.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  /// The featured section: قسم التهجي, or null if the data is unavailable.
  static Program? _spelling(List<Program>? sections) {
    if (sections == null) return null;
    for (final s in sections) {
      if (s.id == 'sec-spelling') return s;
    }
    return null;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final institution = ref.watch(institutionProvider);
    final student = ref.watch(studentProvider);
    final currentHalaqa = ref.watch(currentHalaqaProvider);
    final departments = ref.watch(departmentsProvider);
    final companions = ref.watch(companionProgramsProvider);
    final sections = ref.watch(specialSectionsProvider);
    final unread = ref.watch(unreadNotificationCountProvider);

    // The four stat figures resolve only when every source is ready, so a
    // partial "0" is never shown.
    List<HomeStat>? stats;
    final inst = institution.value;
    final deps = departments.value;
    final comps = companions.value;
    if (inst != null && deps != null && comps != null) {
      final totalHalaqat =
          deps.fold<int>(0, (sum, d) => sum + (d.halaqatCount ?? 0));
      stats = [
        HomeStat(
          icon: Icons.layers_outlined,
          value: '${deps.length}',
          caption: 'أقسام تعليمية',
          tone: HomeTileTone.mint,
          sourcePage: 6,
        ),
        HomeStat(
          icon: Icons.groups_2_outlined,
          value: '$totalHalaqat',
          caption: 'حلقة في المسار',
          tone: HomeTileTone.sky,
          sourcePage: 6,
        ),
        HomeStat(
          icon: Icons.category_outlined,
          value: '${inst.fields.length}',
          caption: 'مجالات تعليمية',
          tone: HomeTileTone.lavender,
          sourcePage: 5,
        ),
        HomeStat(
          icon: Icons.auto_stories_outlined,
          value: '${comps.length}',
          caption: 'برامج مرافقة',
          tone: HomeTileTone.peach,
          sourcePage: 10,
        ),
      ];
    }

    return Theme(
      data: HomePalette.themeOf(context),
      child: Builder(
        builder: (context) => Scaffold(
          body: SafeArea(
            bottom: false,
            child: RefreshIndicator(
              onRefresh: () async {
                ref.invalidate(currentHalaqaProvider);
                ref.invalidate(departmentsProvider);
                ref.invalidate(specialSectionsProvider);
              },
              child: CustomScrollView(
                slivers: [
                  // ── Header ──────────────────────────────────────────────
                  SliverGutter(
                    top: Insets.sm,
                    child: HomeHeader(
                      title: inst?.shortName,
                      subtitle: inst?.mission,
                      unreadCount: unread,
                      onNotifications: () =>
                          context.push(Routes.notifications),
                      onProfile: () => context.go(Routes.profile),
                    ),
                  ),

                  // ── Hero ────────────────────────────────────────────────
                  SliverToBoxAdapter(
                    child: Padding(
                      padding: const EdgeInsets.only(top: Insets.lg),
                      child: AsyncView(
                        value: student,
                        loading: const SkeletonBox(height: 240),
                        builder: (context, data) {
                          final halaqa = currentHalaqa.value;
                          return HomeHero(
                            greetingName: data.name,
                            supportingLine:
                                '${data.targetGroupName} · ${data.currentProgramName}',
                            ctaLabel: halaqa == null
                                ? 'تصفّحي الأقسام'
                                : 'تابعي حلقتك القادمة',
                            onCta: halaqa == null
                                ? () => context.go(Routes.programs)
                                : () => context.go(
                                      Routes.episode(
                                          halaqa.programId, halaqa.id),
                                    ),
                          );
                        },
                      ),
                    ),
                  ),

                  // ── Stats ───────────────────────────────────────────────
                  SliverGutter(
                    top: Insets.xxl,
                    child: stats == null
                        ? const SkeletonBox(height: 180)
                        : HomeStatsCard(stats: stats),
                  ),

                  // ── Categories ──────────────────────────────────────────
                  SliverGutter(
                    top: Insets.xxxl,
                    child: SectionHeader(
                      title: 'أقسامنا التعليمية',
                      subtitle: 'الأقسام الخمسة كما وردت في الملف التعريفي',
                      actionLabel: 'عرض جميع الأقسام',
                      onAction: () => context.go(Routes.programs),
                      trailing: const SourceChip(page: 6),
                    ),
                  ),
                  SliverGutter(
                    top: Insets.lg,
                    child: AsyncView(
                      value: departments,
                      loading: const SkeletonBox(height: 240),
                      builder: (context, list) => HomeCategoryGrid(
                        departments: list,
                        onOpen: (program) =>
                            context.go(Routes.program(program.id)),
                      ),
                    ),
                  ),

                  // ── Featured ────────────────────────────────────────────
                  SliverGutter(
                    top: Insets.xxxl,
                    child: SectionHeader(
                      title: 'برامج مميزة',
                      subtitle: 'أبرز ما تقدّمه المؤسسة',
                      actionLabel: 'عرض جميع البرامج',
                      onAction: () => context.go(Routes.programs),
                    ),
                  ),
                  SliverGutter(
                    top: Insets.lg,
                    child: AsyncView(
                      value: sections,
                      loading: const SkeletonBox(height: 220),
                      builder: (context, list) {
                        final featured = _spelling(list);
                        if (featured == null) return const SizedBox.shrink();
                        return HomeFeaturedCard(
                          program: featured,
                          onOpen: () =>
                              context.go(Routes.program(featured.id)),
                        );
                      },
                    ),
                  ),

                  const SliverToBoxAdapter(
                    child: SizedBox(height: Insets.giant),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

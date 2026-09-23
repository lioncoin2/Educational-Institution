import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../data/models/program.dart';
import '../../providers/app_providers.dart';
import '../notifications/state/unread_count_controller.dart';
import 'widgets/home_category_grid.dart';
import 'widgets/home_featured_card.dart';
import 'widgets/home_header.dart';
import 'widgets/home_hero.dart';
import 'widgets/home_palette.dart';
import 'widgets/home_stats_card.dart';

/// The home landing screen: institution identity, a golden-hour hero, key
/// figures, the department grid and a featured section — laid out to the
/// reference composition.
///
/// Home wears the institution's emblem green rather than the app's plum, via a
/// [HomePalette] Theme wrapper applied here — below the shared navigation
/// shell, so no other tab is affected and the bottom-nav pill stays plum. Every
/// figure and string shown is real institution data.
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
    final departments = ref.watch(departmentsProvider);
    final companions = ref.watch(companionProgramsProvider);
    final sections = ref.watch(specialSectionsProvider);
    final unread = ref.watch(unreadNotificationCountProvider);

    final inst = institution.value;
    final deps = departments.value;
    final comps = companions.value;

    // The four figures resolve only when every source is ready, so a partial
    // "0" is never shown.
    List<HomeStat>? stats;
    if (inst != null && deps != null && comps != null) {
      final totalHalaqat =
          deps.fold<int>(0, (sum, d) => sum + (d.halaqatCount ?? 0));
      stats = [
        HomeStat(
          icon: Icons.layers_outlined,
          value: '${deps.length}',
          caption: 'أقسام تعليمية',
          tone: HomeTileTone.mint,
        ),
        HomeStat(
          icon: Icons.groups_2_outlined,
          value: '$totalHalaqat',
          caption: 'حلقة تعليمية',
          tone: HomeTileTone.sky,
        ),
        HomeStat(
          icon: Icons.category_outlined,
          value: '${inst.fields.length}',
          caption: 'مجالات تعليمية',
          tone: HomeTileTone.lavender,
        ),
        HomeStat(
          icon: Icons.auto_stories_outlined,
          value: '${comps.length}',
          caption: 'برامج مرافقة',
          tone: HomeTileTone.peach,
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
                ref.invalidate(departmentsProvider);
                ref.invalidate(specialSectionsProvider);
                ref.invalidate(companionProgramsProvider);
                // Keep the spinner until the reload actually completes.
                await Future.wait([
                  ref.read(departmentsProvider.future),
                  ref.read(specialSectionsProvider.future),
                  ref.read(companionProgramsProvider.future),
                ]);
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

                  // ── Hero (full-bleed) ───────────────────────────────────
                  SliverToBoxAdapter(
                    child: Padding(
                      padding: const EdgeInsets.only(top: Insets.sm),
                      child: HomeHero(
                        headline: 'مرحباً بك',
                        subhead: 'في رحلتك مع القرآن الكريم',
                        slogan: inst?.mission ?? '',
                        ctaLabel: 'ابدأ رحلتك الآن',
                        onCta: () => context.go(Routes.programs),
                      ),
                    ),
                  ),

                  // ── Stats ───────────────────────────────────────────────
                  SliverGutter(
                    top: Insets.md,
                    child: stats == null
                        ? const SkeletonBox(height: 132)
                        : HomeStatsCard(stats: stats),
                  ),

                  // ── Categories ──────────────────────────────────────────
                  SliverGutter(
                    top: Insets.xl,
                    child: SectionHeader(
                      title: 'أقسامنا التعليمية',
                      subtitle: 'الأقسام الخمسة كما وردت في الملف التعريفي',
                      trailing: _SeeAll(
                        label: 'عرض جميع الأقسام',
                        onTap: () => context.go(Routes.programs),
                      ),
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
                    top: Insets.xl,
                    child: SectionHeader(
                      title: 'برامج مميزة',
                      subtitle: 'أبرز ما تقدّمه المؤسسة',
                      trailing: _SeeAll(
                        label: 'عرض جميع البرامج',
                        onTap: () => context.go(Routes.programs),
                      ),
                    ),
                  ),
                  SliverGutter(
                    top: Insets.lg,
                    child: AsyncView(
                      value: sections,
                      loading: const SkeletonBox(height: 200),
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

/// The "عرض جميع…" action: label then a forward arrow that auto-mirrors to
/// point left (the RTL forward cue), matching the reference's section headers.
class _SeeAll extends StatelessWidget {
  const _SeeAll({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: onTap,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Flexible so the label ellipsises rather than overflowing the header
          // action at the largest text scales on a small phone.
          Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis)),
          const SizedBox(width: Insets.xs),
          const Icon(Icons.arrow_forward_rounded, size: 18),
        ],
      ),
    );
  }
}

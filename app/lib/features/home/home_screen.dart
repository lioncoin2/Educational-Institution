import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../core/widgets/patterns/announcement_card.dart';
import '../../core/widgets/patterns/path_stepper.dart';
import '../../core/widgets/patterns/program_card.dart';
import '../../providers/app_providers.dart';
import 'widgets/home_greeting.dart';
import 'widgets/next_halaqa_card.dart';
import 'widgets/progress_summary_card.dart';

/// Answers two questions in the first screenful: where am I, and what is next.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final student = ref.watch(studentProvider);
    final currentHalaqa = ref.watch(currentHalaqaProvider);
    final path = ref.watch(pathProvider);
    final progress = ref.watch(progressProvider);
    final sections = ref.watch(specialSectionsProvider);
    final announcements = ref.watch(announcementsProvider);
    final unread = ref.watch(unreadNotificationCountProvider);

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(currentHalaqaProvider);
            ref.invalidate(pathProvider);
            ref.invalidate(progressProvider);
            ref.invalidate(announcementsProvider);
          },
          child: CustomScrollView(
            slivers: [
              SliverToBoxAdapter(
                child: AsyncView(
                  value: student,
                  loading: const SizedBox(height: 180),
                  builder: (context, data) => HomeGreeting(
                    student: data,
                    unreadCount: unread,
                    onNotifications: () => context.push(Routes.notifications),
                  ),
                ),
              ),

              // ── الحلقة القادمة ──────────────────────────────────────────
              SliverGutter(
                top: Insets.xxl,
                child: AsyncView(
                  value: currentHalaqa,
                  loading: const SkeletonBox(height: 168),
                  builder: (context, halaqa) => halaqa == null
                      ? const SizedBox.shrink()
                      : NextHalaqaCard(
                          halaqa: halaqa,
                          onOpen: () => context.go(
                            Routes.episode(halaqa.programId, halaqa.id),
                          ),
                        ),
                ),
              ),

              // ── المسار المتدرّج ─────────────────────────────────────────
              SliverGutter(
                top: Insets.xxxl,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SectionHeader(
                      title: 'مسارك المتدرّج',
                      subtitle: 'الأقسام الخمسة كما وردت في الملف التعريفي',
                      actionLabel: 'التفاصيل',
                      onAction: () => context.go(Routes.path),
                    ),
                    const SizedBox(height: Insets.lg),
                    AsyncView(
                      value: path,
                      loading: const SkeletonBox(height: 44),
                      builder: (context, steps) => PathStepper(
                        steps: steps,
                        compact: true,
                        onStepTap: (step) =>
                            context.go(Routes.levels(step.programId)),
                      ),
                    ),
                  ],
                ),
              ),

              // ── التقدّم ─────────────────────────────────────────────────
              SliverGutter(
                top: Insets.xxxl,
                child: AsyncView(
                  value: progress,
                  loading: const SkeletonBox(height: 150),
                  builder: (context, data) => ProgressSummaryCard(
                    progress: data,
                    onTap: () => context.push(Routes.progress),
                  ),
                ),
              ),

              // ── أقسام خاصة ─────────────────────────────────────────────
              SliverGutter(
                top: Insets.xxxl,
                child: SectionHeader(
                  title: 'أقسام خاصة',
                  subtitle: 'التهجي · البراعم · اللغات',
                  actionLabel: 'كل البرامج',
                  onAction: () => context.go(Routes.programs),
                ),
              ),
              AsyncView(
                value: sections,
                loading: const SliverToBoxAdapter(
                  child: Padding(
                    padding: EdgeInsets.all(Insets.lg),
                    child: SkeletonBox(height: 120),
                  ),
                ),
                builder: (context, list) => SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.only(top: Insets.lg),
                    child: ResponsiveBody(
                      child: Column(
                        children: [
                          for (final program in list)
                            Padding(
                              padding: const EdgeInsets.only(bottom: Insets.md),
                              child: ProgramCard(
                                program: program,
                                onTap: () =>
                                    context.go(Routes.program(program.id)),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),

              // ── من قسم الإعلام ─────────────────────────────────────────
              SliverGutter(
                top: Insets.xl,
                child: SectionHeader(
                  title: 'من قسم الإعلام',
                  subtitle: 'أحدث الإعلانات والتغطيات',
                  actionLabel: 'الكل',
                  onAction: () => context.push(Routes.announcements),
                ),
              ),
              SliverGutter(
                top: Insets.lg,
                child: AsyncView(
                  value: announcements,
                  loading: const SkeletonBox(height: 140),
                  builder: (context, list) => Column(
                    children: [
                      for (final item in list.take(2))
                        Padding(
                          padding: const EdgeInsets.only(bottom: Insets.md),
                          child: AnnouncementCard(
                            announcement: item,
                            compact: true,
                          ),
                        ),
                    ],
                  ),
                ),
              ),

              const SliverToBoxAdapter(child: SizedBox(height: Insets.giant)),
            ],
          ),
        ),
      ),
    );
  }
}

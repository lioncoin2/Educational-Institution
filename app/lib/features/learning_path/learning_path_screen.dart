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
import '../../core/widgets/patterns/path_stepper.dart';
import '../../data/models/learning.dart';
import '../../providers/app_providers.dart';
import 'widgets/path_continue_card.dart';
import 'widgets/path_hero_band.dart';
import 'widgets/path_overview_card.dart';
import 'widgets/path_palette.dart';

/// مساري — the graded ladder of the five departments from page 6 of the
/// institution profile, with the learner's position on it: placeholder data
/// in the demo; against the backend, the learner's real enrollment and no
/// progress at all, because none is recorded yet.
///
/// The screen is dressed in the institution's emblem green rather than the
/// app's plum. That is done by a single [Theme] wrapper here, below the shared
/// navigation shell, so the palette cannot leak into any other tab — see
/// [PathPalette]. One consequence is deliberate and visible: the bottom
/// navigation bar's selected pill stays plum, because it is painted by the
/// shared shell above this widget.
class LearningPathScreen extends ConsumerWidget {
  const LearningPathScreen({super.key});

  /// The rung the learner currently stands on, or null if there is none.
  /// A plain loop rather than `firstOrNull`, which would pull in a package.
  static PathStep? _currentStep(List<PathStep>? steps) {
    if (steps == null) return null;
    for (final step in steps) {
      if (step.state == ProgressState.current) return step;
    }
    return null;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Against the backend مساري is the signed-in person's own record, read
    // from the server; in the demo it is placeholder data, marked as such.
    final backend = ref.watch(backendModeProvider);
    final signedOut =
        backend &&
        switch (ref.watch(sessionUserProvider)) {
          AsyncData(:final value) => value == null,
          _ => false,
        };
    final path = ref.watch(pathProvider);
    final progress = ref.watch(progressProvider);
    final currentHalaqa = ref.watch(currentHalaqaProvider);
    final currentStep = signedOut ? null : _currentStep(path.value);

    return Theme(
      data: PathPalette.themeOf(context),
      // Builder so everything below reads the scoped green scheme.
      child: Builder(
        builder: (context) => Scaffold(
          body: SafeArea(
            bottom: false,
            child: CustomScrollView(
              slivers: [
                // Bare adapter: SliverGutter would apply the responsive gutter
                // and break the full-bleed band.
                SliverToBoxAdapter(
                  child: PathHeroBand(
                    onContinue: currentStep == null
                        ? null
                        : () =>
                              context.go(Routes.levels(currentStep.programId)),
                  ),
                ),

                if (signedOut)
                  SliverGutter(
                    child: EmptyState(
                      icon: Icons.lock_outline_rounded,
                      title: 'سجّلي الدخول لعرض مسارك',
                      actionLabel: 'تسجيل الدخول',
                      onAction: () => context.push(Routes.signIn),
                    ),
                  )
                else ...[
                  SliverGutter(
                    top: Insets.xxl,
                    child: PathOverviewCard(progress: progress),
                  ),

                  if (currentStep != null)
                    SliverGutter(
                      top: Insets.xl,
                      child: AsyncView(
                        value: currentHalaqa,
                        loading: const SkeletonBox(height: 260),
                        builder: (context, halaqa) => halaqa == null
                            ? const SizedBox.shrink()
                            : PathContinueCard(
                                step: currentStep,
                                halaqa: halaqa,
                                onOpen: () => context.go(
                                  Routes.episode(halaqa.programId, halaqa.id),
                                ),
                              ),
                      ),
                    )
                  // A real record with no current enrollment says exactly
                  // that — not "awaiting registration", which is not a state
                  // the institution's records have.
                  else if (backend && path.hasValue)
                    const SliverGutter(
                      top: Insets.xl,
                      child: _NotEnrolledCard(),
                    ),

                  SliverGutter(
                    top: Insets.xxxl,
                    child: SectionHeader(
                      title: 'رحلتي في الأقسام',
                      subtitle: backend
                          ? 'الأقسام وعدد حلقاتها كما في سجلات المؤسسة'
                          : 'ترتيب الأقسام وعدد حلقاتها كما وردت في الملف التعريفي',
                      trailing: backend ? null : const SourceChip(page: 6),
                      // A root route, so pushing it keeps مساري selected. The
                      // label is never the bare 'تقدّمي' — that exact string is
                      // tapped by navigation_test on the profile screen.
                      actionLabel: 'تفاصيل تقدّمي',
                      onAction: () => context.push(Routes.progress),
                    ),
                  ),

                  if (!backend)
                    SliverGutter(
                      top: Insets.lg,
                      child: const MockBanner(
                        message:
                            'ترتيب الأقسام وعدد حلقاتها مأخوذان من الملف التعريفي. '
                            'موقعك على المسار ونِسَب الإنجاز بيانات تجريبية.',
                      ),
                    ),

                  SliverGutter(
                    top: Insets.lg,
                    child: AsyncView(
                      value: path,
                      loading: const SkeletonBox(height: 420),
                      onRetry: () => ref.invalidate(pathProvider),
                      builder: (context, steps) => PathStepper(
                        steps: steps,
                        onStepTap: (step) =>
                            context.go(Routes.levels(step.programId)),
                      ),
                    ),
                  ),
                ],

                const SliverToBoxAdapter(child: SizedBox(height: Insets.giant)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// No ACTIVE enrollment on the server: said plainly, with nothing to do —
/// enrolling is not something this app offers.
class _NotEnrolledCard extends StatelessWidget {
  const _NotEnrolledCard();

  @override
  Widget build(BuildContext context) {
    return AppCard(
      borderRadius: Radii.brXl,
      child: Row(
        children: [
          Icon(Icons.info_outline_rounded, color: context.colors.primary),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Text(
              'لا يوجد تسجيل نشط لكِ في حلقة من حلقات هذه الأقسام.',
              style: context.text.bodyMedium,
            ),
          ),
        ],
      ),
    );
  }
}

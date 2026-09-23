import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/theme/app_typography.dart';
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
import '../../data/models/learning.dart';
import '../../providers/app_providers.dart';

/// A single lesson. Content is placeholder — the profile does not describe
/// lesson-level material — but the shape shows how a real lesson would read.
class LessonScreen extends ConsumerWidget {
  const LessonScreen({
    super.key,
    required this.programId,
    required this.halaqaId,
    required this.lessonId,
  });

  final String programId;
  final String halaqaId;
  final String lessonId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lesson = ref.watch(
      lessonProvider((halaqaId: halaqaId, lessonId: lessonId)),
    );
    final halaqa = ref.watch(halaqaProvider(halaqaId));

    return AsyncView(
      value: lesson,
      loading: Scaffold(
        appBar: AppBar(title: const Text('الدرس')),
        body: const Center(child: CircularProgressIndicator()),
      ),
      builder: (context, data) {
        if (data == null) {
          return Scaffold(
            appBar: AppBar(title: const Text('الدرس')),
            body: const EmptyState(
              icon: Icons.search_off_rounded,
              title: 'لم نجد هذا الدرس',
            ),
          );
        }
        return _Body(
          programId: programId,
          lesson: data,
          halaqa: halaqa.value,
        );
      },
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({
    required this.programId,
    required this.lesson,
    required this.halaqa,
  });

  final String programId;
  final Lesson lesson;
  final Halaqa? halaqa;

  Lesson? get _next {
    final list = halaqa?.lessons;
    if (list == null) return null;
    final index = list.indexWhere((l) => l.id == lesson.id);
    if (index == -1 || index + 1 >= list.length) return null;
    return list[index + 1];
  }

  @override
  Widget build(BuildContext context) {
    final next = _next;
    final done = lesson.state == LessonState.completed;

    return Scaffold(
      appBar: AppBar(title: Text('الدرس ${lesson.order}')),
      body: SafeArea(
        top: false,
        child: CustomScrollView(
          slivers: [
            SliverToBoxAdapter(child: _PassageBand(lesson: lesson)),

            SliverGutter(
              top: Insets.xxl,
              child: Row(
                children: [
                  Expanded(
                    child: Text(lesson.title, style: context.text.headlineMedium),
                  ),
                  if (done)
                    Icon(Icons.check_circle_rounded,
                        color: context.colors.tertiary),
                ],
              ),
            ),

            SliverGutter(
              top: Insets.lg,
              child: Text(lesson.summary, style: context.text.bodyLarge),
            ),

            SliverGutter(
              top: Insets.xl,
              child: AppCard(
                color: context.colors.surfaceContainerLow,
                child: Column(
                  children: [
                    InfoRow(
                      icon: Icons.timer_outlined,
                      label: 'مدة الجلسة',
                      value: lesson.durationLabel,
                    ),
                    if (halaqa?.teacherName case final teacher?)
                      InfoRow(
                        icon: Icons.person_outline_rounded,
                        label: 'المعلّمة',
                        value: teacher,
                      ),
                    InfoRow(
                      icon: Icons.flag_outlined,
                      label: 'الحالة',
                      value: switch (lesson.state) {
                        LessonState.completed => 'مكتمل',
                        LessonState.current => 'الدرس الحالي',
                        LessonState.locked => 'يفتح بعد الدرس السابق',
                      },
                    ),
                  ],
                ),
              ),
            ),

            SliverGutter(
              top: Insets.xl,
              child: const SectionHeader(title: 'أهداف الدرس'),
            ),
            SliverGutter(
              top: Insets.lg,
              child: AppCard(child: BulletList(items: lesson.objectives)),
            ),

            SliverGutter(
              top: Insets.xl,
              child: const MockBanner(
                message:
                    'محتوى الدرس وأهدافه ومدته بيانات تجريبية. الملف التعريفي '
                    'لا يتضمّن تفصيلاً على مستوى الدرس.',
              ),
            ),

            // Clearance for the pinned BottomActionBar.
            const SliverToBoxAdapter(child: SizedBox(height: 96)),
          ],
        ),
      ),
      bottomNavigationBar: BottomActionBar(
        child: Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: () => context.toast(
                    done
                        ? 'الدرس مكتمل بالفعل — حفظ الحالة يحتاج نظاماً حقيقياً'
                        : 'تسجيل إتمام الدرس يحتاج نظاماً حقيقياً، '
                            'وهو خارج نطاق النموذج الأولي',
                  ),
                  icon: Icon(
                    done ? Icons.check_circle_outline : Icons.check_rounded,
                  ),
                  label: Text(done ? 'مكتمل' : 'أتممتُ الدرس'),
                ),
              ),
              if (next != null && next.state != LessonState.locked) ...[
                const SizedBox(width: Insets.md),
                IconButton.filledTonal(
                  tooltip: 'الدرس التالي',
                  onPressed: () => context.go(
                    Routes.lesson(programId, lesson.halaqaId, next.id),
                  ),
                  icon: const Icon(Icons.arrow_forward_rounded),
                ),
              ],
          ],
        ),
      ),
    );
  }
}

/// Dark band carrying the assigned passage, set in the Quranic face.
class _PassageBand extends StatelessWidget {
  const _PassageBand({required this.lesson});

  final Lesson lesson;

  @override
  Widget build(BuildContext context) {
    return ContourBand(
      background: AppColors.bgDark,
      lineColor: AppColors.primarySoft,
      opacity: 0.18,
      borderRadius: const BorderRadius.vertical(bottom: Radii.xl),
      padding: const EdgeInsets.only(top: Insets.sm, bottom: Insets.xxl),
      child: ResponsiveBody(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              spacing: Insets.sm,
              runSpacing: Insets.sm,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(
                  'المقطع المقرّر',
                  style: context.text.labelMedium
                      ?.copyWith(color: AppColors.primarySoft),
                ),
                const MockChip(compact: true),
              ],
            ),
            const SizedBox(height: Insets.md),
            Text(
              lesson.passageLabel,
              style: const TextStyle(
                fontFamily: AppFonts.quran,
                fontSize: 30,
                height: 1.9,
                color: Colors.white,
              ),
            ),
            const SizedBox(height: Insets.md),
            Container(
              width: 56,
              height: 3,
              decoration: BoxDecoration(
                color: AppColors.accentGold,
                borderRadius: Radii.pill,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

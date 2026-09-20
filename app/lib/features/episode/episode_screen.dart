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
import '../../core/widgets/foundations/progress_indicators.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/layout/bottom_action_bar.dart';
import '../../core/widgets/patterns/info_row.dart';
import '../../core/widgets/patterns/lesson_tile.dart';
import '../../data/models/learning.dart';
import '../../providers/app_providers.dart';

/// One حلقة: who teaches it, when it runs, attendance, and its lessons.
class EpisodeScreen extends ConsumerWidget {
  const EpisodeScreen({
    super.key,
    required this.programId,
    required this.halaqaId,
  });

  final String programId;
  final String halaqaId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final halaqa = ref.watch(halaqaProvider(halaqaId));

    return AsyncView(
      value: halaqa,
      loading: Scaffold(
        appBar: AppBar(title: const Text('الحلقة')),
        body: const Center(child: CircularProgressIndicator()),
      ),
      builder: (context, data) {
        if (data == null) {
          return Scaffold(
            appBar: AppBar(title: const Text('الحلقة')),
            body: const EmptyState(
              icon: Icons.search_off_rounded,
              title: 'لم نجد هذه الحلقة',
            ),
          );
        }
        return _Body(programId: programId, halaqa: data);
      },
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.programId, required this.halaqa});

  final String programId;
  final Halaqa halaqa;

  Lesson? get _nextLesson {
    for (final lesson in halaqa.lessons) {
      if (lesson.state == LessonState.current) return lesson;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final next = _nextLesson;

    return Scaffold(
      appBar: AppBar(title: Text(halaqa.name)),
      body: SafeArea(
        top: false,
        child: CustomScrollView(
          slivers: [
            SliverGutter(
              child: AppCard(
                elevated: true,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(halaqa.name,
                              style: context.text.headlineMedium),
                        ),
                        const MockChip(compact: true),
                      ],
                    ),
                    const SizedBox(height: Insets.lg),
                    InfoRow(
                      icon: Icons.person_outline_rounded,
                      label: 'المعلّمة',
                      value: halaqa.teacherName,
                    ),
                    InfoRow(
                      icon: Icons.schedule_rounded,
                      label: 'الموعد',
                      value: halaqa.scheduleLabel,
                    ),
                    InfoRow(
                      icon: Icons.chat_bubble_outline_rounded,
                      label: 'مجموعة الحلقة',
                      value: halaqa.groupChannelLabel,
                    ),
                    const SizedBox(height: Insets.md),
                    OutlinedButton.icon(
                      onPressed: () => context.toast(
                        'الربط بمجموعات واتساب وتلغرام خارج نطاق النموذج الأولي',
                      ),
                      icon: const Icon(Icons.open_in_new_rounded, size: 18),
                      label: const Text('فتح المجموعة'),
                    ),
                  ],
                ),
              ),
            ),

            SliverGutter(
              top: Insets.xl,
              child: AppCard(
                color: context.colors.surfaceContainerLow,
                child: Column(
                  children: [
                    AppProgressBar(
                      value: halaqa.ratio,
                      label: 'الدروس المكتملة',
                      trailingLabel:
                          '${halaqa.completedLessons} من ${halaqa.lessons.length}',
                      height: 10,
                    ),
                    const SizedBox(height: Insets.lg),
                    AppProgressBar(
                      value: halaqa.attendanceRatio,
                      label: 'الحضور',
                      trailingLabel:
                          '${halaqa.attendedSessions} من ${halaqa.totalSessions}',
                      color: context.colors.tertiary,
                      height: 10,
                    ),
                  ],
                ),
              ),
            ),

            SliverGutter(
              top: Insets.xl,
              child: SectionHeader(
                title: 'الدروس',
                subtitle: '${halaqa.lessons.length} دروس في هذه الحلقة',
                trailing: const MockChip(compact: true),
              ),
            ),

            SliverGutter(
              top: Insets.lg,
              bottom: 96,
              child: Column(
                children: [
                  for (var i = 0; i < halaqa.lessons.length; i++)
                    LessonTile(
                      lesson: halaqa.lessons[i],
                      isLast: i == halaqa.lessons.length - 1,
                      onTap: () => context.go(
                        Routes.lesson(
                          programId,
                          halaqa.id,
                          halaqa.lessons[i].id,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: next == null
          ? null
          : BottomActionBar(
              child: FilledButton.icon(
                onPressed: () => context.go(
                  Routes.lesson(programId, halaqa.id, next.id),
                ),
                icon: const Icon(Icons.play_arrow_rounded),
                label: Text(
                  'تابعي: ${next.title}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
    );
  }
}

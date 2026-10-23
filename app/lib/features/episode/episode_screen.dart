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
import '../../data/models/communities.dart';
import '../../data/models/learning.dart';
import '../../providers/app_providers.dart';
import '../auth/sign_in_prompt.dart';
import '../communities/state/community_chat_opener.dart';
import '../communities/state/community_list_controller.dart';
import '../communities/widgets/community_tile.dart';

/// One حلقة: who teaches it, when it runs, attendance, and its lessons — as
/// far as they are known. Against the backend only the halaqa itself, the
/// learner's enrollment in it and, for their own halaqa, its teachers are
/// recorded; nothing else is drawn.
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
      onRetry: () => ref.invalidate(halaqaProvider(halaqaId)),
      errorBuilder: (context, error) => switch (SignInPrompt.forError(error)) {
        final prompt? => Scaffold(
          appBar: AppBar(title: const Text('الحلقة')),
          body: prompt,
        ),
        null => null,
      },
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
                          child: Text(
                            halaqa.name,
                            style: context.text.headlineMedium,
                          ),
                        ),
                        if (halaqa.origin.isMock) const MockChip(compact: true),
                      ],
                    ),
                    const SizedBox(height: Insets.lg),
                    if (!halaqa.origin.isMock &&
                        halaqa.state == ProgressState.current)
                      const InfoRow(
                        icon: Icons.how_to_reg_outlined,
                        label: 'تسجيلك',
                        value: 'مسجَّلة في هذه الحلقة',
                      ),
                    if (halaqa.teacherName case final teacher?)
                      InfoRow(
                        icon: Icons.person_outline_rounded,
                        label: 'المعلّمة',
                        value: teacher,
                      ),
                    if (halaqa.scheduleLabel case final schedule?)
                      InfoRow(
                        icon: Icons.schedule_rounded,
                        label: 'الموعد',
                        value: schedule,
                      ),
                    if (halaqa.groupChannelLabel case final channel?) ...[
                      InfoRow(
                        icon: Icons.chat_bubble_outline_rounded,
                        label: 'مجموعة الحلقة',
                        value: channel,
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
                  ],
                ),
              ),
            ),

            LinkedHalaqaCommunities(halaqaId: halaqa.id),

            // Nothing about lessons or attendance is recorded for it: say so,
            // rather than draw empty bars.
            if (!halaqa.hasProgress && !halaqa.origin.isMock)
              SliverGutter(
                top: Insets.xl,
                bottom: 96,
                child: AppCard(
                  color: context.colors.surfaceContainerLow,
                  child: Text(
                    'لا توجد دروس أو حضور مسجَّل لهذه الحلقة بعد.',
                    style: context.text.bodyMedium,
                  ),
                ),
              ),

            if (halaqa.hasProgress || halaqa.origin.isMock) ...[
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
          ],
        ),
      ),
      bottomNavigationBar: next == null
          ? null
          : BottomActionBar(
              child: FilledButton.icon(
                onPressed: () =>
                    context.go(Routes.lesson(programId, halaqa.id, next.id)),
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

/// The in-app communities (groups and channels) linked to THIS halaqa (Q50).
///
/// Read from the viewer's own communities — each already carries its
/// `halaqaIds`, the same association institutional oversight manages from the
/// community side; no parallel link is introduced and no new repository is
/// added. Tapping one opens its current destination — the community's
/// conversation — through the shared [communityChatOpenerProvider], exactly as
/// «مجتمعاتي» does. Supplementary and self-effacing: while the viewer's
/// community list is still loading or unavailable, or when none are linked, the
/// section simply does not appear, so the halaqa detail never waits on it.
///
/// Membership-scoped BY DESIGN (final owner decision): it shows ONLY the
/// communities the viewer is an active member of that are linked to this
/// halaqa. This is guaranteed by the source, not re-derived here —
/// `communityListProvider` reads `GET /communities?scope=mine`, i.e. the
/// authenticated viewer's ACTIVE memberships (backend
/// `myCommunities(principal.userId)`, an inner join on `community_members`
/// where `user_id = viewer AND status = ACTIVE`). A community the viewer is
/// not a member of is never in that list, so it is never shown here — even
/// when it is linked to this halaqa.
class LinkedHalaqaCommunities extends ConsumerWidget {
  const LinkedHalaqaCommunities({super.key, required this.halaqaId});

  final String halaqaId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final communities = ref.watch(communityListProvider);
    final linked = [
      for (final community
          in communities.asData?.value.items ?? const <Community>[])
        if (community.halaqaIds.contains(halaqaId)) community,
    ];
    if (linked.isEmpty) {
      return const SliverToBoxAdapter(child: SizedBox.shrink());
    }
    return SliverGutter(
      top: Insets.xl,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SectionHeader(
            title: 'المجتمعات المرتبطة',
            subtitle: 'الكروبات والقنوات المرتبطة بهذه الحلقة',
          ),
          const SizedBox(height: Insets.md),
          for (final community in linked)
            Padding(
              key: ValueKey('halaqa-community-${community.id}'),
              padding: const EdgeInsets.only(bottom: Insets.sm),
              child: _OpenableHalaqaCommunity(community: community),
            ),
        ],
      ),
    );
  }
}

/// A linked-community row that opens the community's conversation on tap — the
/// same canonical resolve «مجتمعاتي» uses (asks messaging, which asks the
/// community whether the viewer may read it NOW; a stale membership is told the
/// chat is not theirs). Disabled while it asks; a refusal is said in words and
/// nothing opens.
class _OpenableHalaqaCommunity extends ConsumerStatefulWidget {
  const _OpenableHalaqaCommunity({required this.community});

  final Community community;

  @override
  ConsumerState<_OpenableHalaqaCommunity> createState() =>
      _OpenableHalaqaCommunityState();
}

class _OpenableHalaqaCommunityState
    extends ConsumerState<_OpenableHalaqaCommunity> {
  bool _opening = false;

  Future<void> _open() async {
    if (_opening) return;
    setState(() => _opening = true);
    final opening = await ref
        .read(communityChatOpenerProvider)
        .open(widget.community.id);
    if (!mounted) return;
    setState(() => _opening = false);
    switch (opening) {
      case OpenChat(:final location):
        context.push(location);
      case CannotOpenChat(:final message):
        context.toast(message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return CommunityTile(community: widget.community, onTap: _open);
  }
}

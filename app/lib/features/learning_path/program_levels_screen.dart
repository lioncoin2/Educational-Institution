import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/foundations/progress_indicators.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/patterns/halaqa_card.dart';
import '../../data/models/data_origin.dart';
import '../../data/models/learning.dart';
import '../../providers/app_providers.dart';

/// The levels of one program: its halaqat, in order, with the learner's
/// position. In the demo the number of halaqat matches the profile exactly
/// and the rest is placeholder; against the backend they are the halaqat the
/// institution records, with the learner's own marked — and no progress.
class ProgramLevelsScreen extends ConsumerWidget {
  const ProgramLevelsScreen({super.key, required this.programId});

  final String programId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final program = ref.watch(programProvider(programId));
    final halaqat = ref.watch(halaqatProvider(programId));

    return Scaffold(
      appBar: AppBar(
        title: const Text('المسار والمستويات'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(24),
          child: Align(
            alignment: AlignmentDirectional.centerStart,
            child: Padding(
              padding: EdgeInsetsDirectional.only(
                start: context.gutter,
                bottom: Insets.sm,
              ),
              child: AsyncView(
                value: program,
                loading: const SizedBox(height: 16),
                builder: (context, data) =>
                    Text(data?.name ?? '', style: context.text.labelMedium),
              ),
            ),
          ),
        ),
      ),
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: halaqat,
          loading: const Center(child: CircularProgressIndicator()),
          onRetry: () => ref.invalidate(halaqatProvider(programId)),
          builder: (context, list) {
            if (list.isEmpty) {
              return program.value?.origin == DataOrigin.records
                  ? const EmptyState(
                      icon: Icons.layers_clear_outlined,
                      title: 'لا توجد حلقات لهذا البرنامج',
                      message: 'لم تُسجَّل له حلقات في سجلات المؤسسة بعد.',
                    )
                  : const EmptyState(
                      icon: Icons.layers_clear_outlined,
                      title: 'لا توجد مستويات مذكورة',
                      message:
                          'لم يرد في الملف التعريفي تفصيل حلقات أو مستويات لهذا '
                          'البرنامج، فلم نخترع له محتوى.',
                    );
            }

            final done = list
                .where((h) => h.state == ProgressState.completed)
                .length;
            // Placeholder progress is shown — and marked — only in the demo;
            // real records carry none, so none is drawn.
            final placeholder = list.any((h) => h.origin.isMock);

            return CustomScrollView(
              slivers: [
                if (placeholder)
                  SliverGutter(
                    top: Insets.lg,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        AppProgressBar(
                          value: list.isEmpty ? 0 : done / list.length,
                          label: 'حلقات مكتملة',
                          trailingLabel: '$done من ${list.length}',
                          height: 10,
                        ),
                        const SizedBox(height: Insets.lg),
                        const MockBanner(
                          message:
                              'عدد الحلقات مطابق لما ورد في الملف التعريفي. '
                              'أسماء المعلّمات والمواعيد ونِسَب الإنجاز تجريبية.',
                        ),
                      ],
                    ),
                  ),
                SliverGutter(
                  top: Insets.xl,
                  child: const SectionHeader(title: 'الحلقات'),
                ),
                SliverGutter(
                  top: Insets.lg,
                  bottom: Insets.giant,
                  child: Column(
                    children: [
                      for (final halaqa in list)
                        Padding(
                          padding: const EdgeInsets.only(bottom: Insets.md),
                          child: HalaqaCard(
                            halaqa: halaqa,
                            onTap: () => context.go(
                              Routes.episode(programId, halaqa.id),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

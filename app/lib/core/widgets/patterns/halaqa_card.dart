import 'package:flutter/material.dart';

import '../../../data/models/learning.dart';
import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';
import '../foundations/app_card.dart';
import '../foundations/mock_ribbon.dart';
import '../foundations/progress_indicators.dart';

/// A حلقة — the unit the institution organises teaching around.
///
/// In the demo the *count* of halaqat per department is from the profile and
/// this card's teacher, schedule and progress are invented, hence the mock
/// chip. Against the server it shows only what is recorded: a row for what
/// is known, none for what is not, and no chip.
class HalaqaCard extends StatelessWidget {
  const HalaqaCard({super.key, required this.halaqa, this.onTap});

  final Halaqa halaqa;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final locked = halaqa.state == ProgressState.locked;
    final isCurrent = halaqa.state == ProgressState.current;

    return Opacity(
      opacity: locked ? 0.55 : 1,
      child: AppCard(
        onTap: locked ? null : onTap,
        borderColor: isCurrent ? context.colors.primary : null,
        semanticLabel: halaqa.teacherName == null
            ? halaqa.name
            : '${halaqa.name} مع ${halaqa.teacherName}',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                _StateDot(state: halaqa.state),
                const SizedBox(width: Insets.md),
                Expanded(
                  child: Text(halaqa.name, style: context.text.titleMedium),
                ),
                if (isCurrent)
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: Insets.md,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: context.colors.primary,
                      borderRadius: Radii.pill,
                    ),
                    child: Text(
                      'الحالية',
                      style: context.text.labelSmall?.copyWith(
                        color: context.colors.onPrimary,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  )
                else if (locked)
                  Icon(Icons.lock_outline_rounded,
                      size: 18, color: context.colors.onSurfaceVariant)
                else
                  Icon(Icons.chevron_right_rounded,
                      color: context.colors.onSurfaceVariant),
              ],
            ),
            if (halaqa.teacherName case final teacher?) ...[
              const SizedBox(height: Insets.md),
              _MetaRow(icon: Icons.person_outline_rounded, text: teacher),
            ],
            if (halaqa.scheduleLabel case final schedule?) ...[
              const SizedBox(height: Insets.sm),
              _MetaRow(icon: Icons.schedule_rounded, text: schedule),
            ],
            if (!locked && halaqa.lessons.isNotEmpty) ...[
              const SizedBox(height: Insets.lg),
              AppProgressBar(
                value: halaqa.ratio,
                label: 'الدروس',
                trailingLabel:
                    '${halaqa.completedLessons} من ${halaqa.lessons.length}',
              ),
            ],
            if (halaqa.origin.isMock) ...[
              const SizedBox(height: Insets.md),
              const Align(
                alignment: AlignmentDirectional.centerStart,
                child: MockChip(compact: true),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _StateDot extends StatelessWidget {
  const _StateDot({required this.state});

  final ProgressState state;

  @override
  Widget build(BuildContext context) {
    final (bg, fg, icon) = switch (state) {
      ProgressState.completed => (
          context.colors.tertiaryContainer,
          context.colors.onTertiaryContainer,
          Icons.check_rounded,
        ),
      ProgressState.current => (
          context.colors.primary,
          context.colors.onPrimary,
          Icons.play_arrow_rounded,
        ),
      ProgressState.available || ProgressState.none => (
          context.colors.primaryContainer,
          context.colors.onPrimaryContainer,
          Icons.circle_outlined,
        ),
      ProgressState.locked => (
          context.colors.surfaceContainerHigh,
          context.colors.onSurfaceVariant,
          Icons.lock_outline_rounded,
        ),
    };

    return Container(
      width: 36,
      height: 36,
      decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
      child: Icon(icon, size: 18, color: fg),
    );
  }
}

class _MetaRow extends StatelessWidget {
  const _MetaRow({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 16, color: context.colors.onSurfaceVariant),
        const SizedBox(width: Insets.sm),
        Expanded(
          child: Text(
            text,
            style: context.text.bodySmall,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}

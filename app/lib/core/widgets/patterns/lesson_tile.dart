import 'package:flutter/material.dart';

import '../../../data/models/learning.dart';
import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';

/// A single lesson row inside a halaqa.
class LessonTile extends StatelessWidget {
  const LessonTile({
    super.key,
    required this.lesson,
    required this.isLast,
    this.onTap,
  });

  final Lesson lesson;
  final bool isLast;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final locked = lesson.state == LessonState.locked;
    final (bg, fg, icon) = switch (lesson.state) {
      LessonState.completed => (
          context.colors.tertiaryContainer,
          context.colors.onTertiaryContainer,
          Icons.check_rounded,
        ),
      LessonState.current => (
          context.colors.primary,
          context.colors.onPrimary,
          Icons.play_arrow_rounded,
        ),
      LessonState.locked => (
          context.colors.surfaceContainerHigh,
          context.colors.onSurfaceVariant,
          Icons.lock_outline_rounded,
        ),
    };

    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 36,
            child: Column(
              children: [
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
                  child: Icon(icon, size: 18, color: fg),
                ),
                if (!isLast)
                  Expanded(
                    child: Container(
                      width: 2,
                      margin: const EdgeInsets.symmetric(vertical: Insets.xs),
                      color: lesson.state == LessonState.completed
                          ? context.colors.tertiary
                          : context.colors.outlineVariant,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(bottom: isLast ? 0 : Insets.lg),
              child: Material(
                color: context.colors.surfaceContainerLowest,
                borderRadius: Radii.brMd,
                child: InkWell(
                  onTap: locked ? null : onTap,
                  borderRadius: Radii.brMd,
                  child: Opacity(
                    opacity: locked ? 0.55 : 1,
                    child: Padding(
                      padding: const EdgeInsets.all(Insets.md),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'الدرس ${lesson.order} · ${lesson.title}',
                                  style: context.text.titleSmall,
                                ),
                                const SizedBox(height: Insets.xs),
                                Row(
                                  children: [
                                    Icon(Icons.timer_outlined,
                                        size: 14,
                                        color: context.colors.onSurfaceVariant),
                                    const SizedBox(width: Insets.xs),
                                    Text(lesson.durationLabel,
                                        style: context.text.labelSmall),
                                  ],
                                ),
                              ],
                            ),
                          ),
                          if (!locked)
                            Icon(Icons.chevron_right_rounded,
                                size: 20,
                                color: context.colors.onSurfaceVariant),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

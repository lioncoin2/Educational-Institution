import 'package:flutter/material.dart';

import '../../extensions/context_ext.dart';

/// A count on an icon: nothing at 0, the number from 1 to 99, "99+" above.
///
/// Decorative — the control it sits on carries the spoken count — so it
/// adds nothing to the semantics tree.
class UnreadBadge extends StatelessWidget {
  const UnreadBadge({super.key, required this.count});

  final int count;

  /// What the badge shows, or null when it shows nothing.
  static String? label(int count) => switch (count) {
    <= 0 => null,
    > 99 => '99+',
    _ => '$count',
  };

  @override
  Widget build(BuildContext context) {
    final text = label(count);
    if (text == null) return const SizedBox.shrink();
    return ExcludeSemantics(
      child: Container(
        constraints: const BoxConstraints(minWidth: 18, minHeight: 18),
        padding: const EdgeInsets.symmetric(horizontal: 5),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: context.colors.error,
          borderRadius: BorderRadius.circular(9),
          border: Border.all(
            color: context.colors.surfaceContainerLowest,
            width: 1.5,
          ),
        ),
        child: Text(
          text,
          // The count is a number: never let a large text scale break the
          // pill out of its corner.
          textScaler: TextScaler.noScaling,
          style: context.text.labelSmall?.copyWith(
            color: context.colors.onError,
            fontWeight: FontWeight.w700,
            fontSize: 10,
            height: 1.2,
          ),
        ),
      ),
    );
  }
}

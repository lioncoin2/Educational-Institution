import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';

/// A thin strip below the timeline naming who is currently typing.
///
/// Ephemeral and realtime-only: the state's [userIds] come from typing hints
/// that each lapse on a timer, so the strip appears and clears on its own.
/// Empty set → nothing shown. Names are resolved from the conversation's known
/// senders; an unknown id falls back to a neutral word rather than a guess.
class TypingIndicator extends StatefulWidget {
  const TypingIndicator({
    super.key,
    required this.userIds,
    required this.nameOf,
  });

  /// The members currently typing (never the viewer).
  final Set<String> userIds;

  /// Resolves a display name for a member, or null when it is not known.
  final String? Function(String userId) nameOf;

  @override
  State<TypingIndicator> createState() => _TypingIndicatorState();
}

class _TypingIndicatorState extends State<TypingIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _dots = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat();

  @override
  void dispose() {
    _dots.dispose();
    super.dispose();
  }

  String get _label {
    final names = [
      for (final id in widget.userIds) widget.nameOf(id) ?? 'عضو',
    ];
    return switch (names.length) {
      0 => '',
      1 => '${names.first} يكتب',
      2 => '${names[0]} و${names[1]} يكتبان',
      _ => 'عدّة أعضاء يكتبون',
    };
  }

  @override
  Widget build(BuildContext context) {
    if (widget.userIds.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.lg,
        vertical: Insets.xs,
      ),
      child: Row(
        children: [
          _TypingDots(animation: _dots, color: context.colors.primary),
          const SizedBox(width: Insets.sm),
          Expanded(
            child: Text(
              _label,
              style: context.text.labelSmall?.copyWith(
                color: context.colors.onSurfaceVariant,
                fontStyle: FontStyle.italic,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}

/// Three dots that rise in turn — a quiet "someone is typing" motion.
class _TypingDots extends StatelessWidget {
  const _TypingDots({required this.animation, required this.color});

  final Animation<double> animation;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: animation,
      builder: (context, _) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < 3; i++)
              Padding(
                padding: EdgeInsets.only(right: i == 2 ? 0 : 3),
                child: Opacity(
                  opacity: _opacityFor(i, animation.value),
                  child: Container(
                    width: 5,
                    height: 5,
                    decoration: BoxDecoration(
                      color: color,
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }

  /// Each dot peaks a third of a cycle after the previous one.
  static double _opacityFor(int index, double t) {
    final phase = (t - index / 3) % 1.0;
    final eased = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
    return 0.3 + 0.7 * eased;
  }
}

import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';

/// The reference's closing banner: a soft green panel with an icon and the
/// institution's line on the right, and a dark-green "explore" button on the
/// left.
///
/// Title and subtitle are real institution content; the button navigates into
/// the real catalogue via [onExplore].
class ProgramsBottomCta extends StatelessWidget {
  const ProgramsBottomCta({
    super.key,
    required this.title,
    required this.subtitle,
    required this.buttonLabel,
    required this.onExplore,
  });

  final String title;
  final String subtitle;
  final String buttonLabel;
  final VoidCallback onExplore;

  @override
  Widget build(BuildContext context) {
    final content = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: context.colors.surfaceContainerLowest,
            shape: BoxShape.circle,
          ),
          child: Icon(Icons.school_rounded, color: context.colors.primary),
        ),
        const SizedBox(width: Insets.md),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                title,
                style: context.text.titleSmall
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 2),
              Text(
                subtitle,
                style: context.text.bodySmall
                    ?.copyWith(color: context.colors.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ],
    );

    final button = FilledButton(
      onPressed: onExplore,
      style: FilledButton.styleFrom(
        backgroundColor: context.colors.primary,
        foregroundColor: context.colors.onPrimary,
        minimumSize: const Size(0, 48),
        padding: const EdgeInsets.symmetric(horizontal: Insets.lg),
        textStyle: context.text.labelLarge?.copyWith(fontWeight: FontWeight.w700),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Flexible(
            child: Text(buttonLabel,
                maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
          const SizedBox(width: Insets.xs),
          const Icon(Icons.arrow_forward_rounded, size: 18),
        ],
      ),
    );

    return Container(
      padding: const EdgeInsets.all(Insets.lg),
      decoration: BoxDecoration(
        color: context.colors.primaryContainer,
        borderRadius: Radii.brXl,
      ),
      // Stack on narrow widths so the button never overflows the content row.
      child: LayoutBuilder(
        builder: (context, constraints) {
          if (constraints.maxWidth < 420) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                content,
                const SizedBox(height: Insets.md),
                Align(
                  alignment: AlignmentDirectional.centerEnd,
                  child: button,
                ),
              ],
            );
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(child: content),
              const SizedBox(width: Insets.md),
              button,
            ],
          );
        },
      ),
    );
  }
}

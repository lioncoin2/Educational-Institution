import 'package:flutter/material.dart';

import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';

/// Section title with the thin rule the profile puts under its headings.
///
/// When the row is too narrow for the title plus its trailing chip/action —
/// which happens on a small phone at the largest text scale — the trailing
/// items move to their own line instead of overflowing.
class SectionHeader extends StatelessWidget {
  const SectionHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.actionLabel,
    this.onAction,
    this.trailing,
  });

  final String title;
  final String? subtitle;
  final String? actionLabel;
  final VoidCallback? onAction;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final titleBlock = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: context.text.titleLarge),
        const SizedBox(height: Insets.xs),
        Container(
          width: 44,
          height: 3,
          decoration: BoxDecoration(
            color: context.colors.primary,
            borderRadius: Radii.pill,
          ),
        ),
        if (subtitle != null) ...[
          const SizedBox(height: Insets.sm),
          Text(subtitle!, style: context.text.bodyMedium),
        ],
      ],
    );

    final tail = <Widget>[
      ?trailing,
      if (actionLabel != null && onAction != null)
        TextButton(onPressed: onAction, child: Text(actionLabel!)),
    ];

    if (tail.isEmpty) return titleBlock;

    return LayoutBuilder(
      builder: (context, constraints) {
        final stacked = constraints.maxWidth < 400;
        if (stacked) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              titleBlock,
              const SizedBox(height: Insets.sm),
              Wrap(spacing: Insets.sm, runSpacing: Insets.sm, children: tail),
            ],
          );
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: titleBlock),
            const SizedBox(width: Insets.sm),
            ...tail,
          ],
        );
      },
    );
  }
}

/// Title plus a provenance chip, laid out so the chip wraps rather than
/// overflows. Used inside cards where [SectionHeader] would be too heavy.
class CardTitleRow extends StatelessWidget {
  const CardTitleRow({super.key, required this.title, this.trailing});

  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    if (trailing == null) {
      return Text(title, style: context.text.titleSmall);
    }
    return Wrap(
      spacing: Insets.sm,
      runSpacing: Insets.sm,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text(title, style: context.text.titleSmall),
        trailing!,
      ],
    );
  }
}

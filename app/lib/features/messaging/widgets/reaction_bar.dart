import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/messaging.dart';

/// The reaction chips under a message (ADR 0053): one per emoji that has at
/// least one reaction, with its count, the viewer's own choice highlighted.
/// Tapping a chip toggles that emoji — the same one the viewer gave removes it.
/// Presentational: it calls [onReact]; the controller owns the toggle.
class ReactionBar extends StatelessWidget {
  const ReactionBar({super.key, required this.reactions, this.onReact});

  final List<MessageReaction> reactions;
  final void Function(String emoji)? onReact;

  @override
  Widget build(BuildContext context) {
    if (reactions.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: Insets.xs),
      child: Wrap(
        spacing: Insets.xs,
        runSpacing: Insets.xs,
        children: [
          for (final reaction in reactions)
            _ReactionChip(
              reaction: reaction,
              onTap: onReact == null ? null : () => onReact!(reaction.emoji),
            ),
        ],
      ),
    );
  }
}

class _ReactionChip extends StatelessWidget {
  const _ReactionChip({required this.reaction, this.onTap});

  final MessageReaction reaction;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = context.colors;
    final selected = reaction.mine;
    return Semantics(
      button: onTap != null,
      selected: selected,
      label: '${reaction.emoji} ${reaction.count}',
      child: InkWell(
        onTap: onTap,
        borderRadius: Radii.pill,
        child: Container(
          padding: const EdgeInsets.symmetric(
            horizontal: Insets.sm,
            vertical: 2,
          ),
          decoration: BoxDecoration(
            color: selected
                ? scheme.primaryContainer
                : scheme.surfaceContainerHighest,
            borderRadius: Radii.pill,
            border: selected ? Border.all(color: scheme.primary) : null,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(reaction.emoji, style: const TextStyle(fontSize: 13)),
              const SizedBox(width: 3),
              Text(
                '${reaction.count}',
                style: context.text.labelSmall?.copyWith(
                  color: selected
                      ? scheme.onPrimaryContainer
                      : scheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

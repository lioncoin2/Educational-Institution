import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../live_copy.dart';

/// Honest "coming later" hints for live features the reference design shows but
/// the platform does NOT yet back (reactions, polls, in-session recording).
///
/// These are deliberately INERT: muted, carrying a «غير متاح الآن» tag, marked
/// `Semantics(enabled: false)`, and wired to no callback — so they signal the
/// roadmap without ever looking functional (the product rule: an unsupported
/// feature must never appear to work). Nothing here reaches a provider, a
/// command, or the media seam.
class LiveComingSoon extends StatelessWidget {
  const LiveComingSoon({super.key});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(
              Icons.auto_awesome_outlined,
              size: 16,
              color: context.colors.onSurfaceVariant,
            ),
            const SizedBox(width: Insets.xs),
            Text(LiveCopy.soonSection, style: context.text.labelLarge),
          ],
        ),
        const SizedBox(height: Insets.xs),
        Text(
          LiveCopy.soonCaption,
          style: context.text.labelSmall?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: Insets.md),
        const Wrap(
          spacing: Insets.sm,
          runSpacing: Insets.sm,
          children: [
            LiveSoonChip(
              icon: Icons.favorite_outline_rounded,
              label: LiveCopy.soonReactions,
            ),
            LiveSoonChip(
              icon: Icons.bar_chart_rounded,
              label: LiveCopy.soonPolls,
            ),
            LiveSoonChip(
              icon: Icons.fiber_manual_record_outlined,
              label: LiveCopy.soonRecording,
            ),
          ],
        ),
      ],
    );
  }
}

/// A single inert "later" pill: a feature icon, its label, and a lock glyph.
/// Short on purpose (so several wrap cleanly on a narrow phone); the
/// «غير متاح الآن» state is carried by the section caption above, the muted
/// styling, the lock, and the (screen-reader) [Semantics] label — never a tap.
class LiveSoonChip extends StatelessWidget {
  const LiveSoonChip({super.key, required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Semantics(
      enabled: false,
      label: '$label — ${LiveCopy.soonBadge}',
      child: Opacity(
        opacity: 0.6,
        child: Container(
          padding: const EdgeInsets.symmetric(
            horizontal: Insets.md,
            vertical: Insets.sm,
          ),
          decoration: BoxDecoration(
            color: colors.surfaceContainer,
            borderRadius: Radii.pill,
            border: Border.all(color: colors.outlineVariant),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 14, color: colors.onSurfaceVariant),
              const SizedBox(width: Insets.xs),
              Text(label, style: context.text.labelMedium),
              const SizedBox(width: Insets.xs),
              Icon(Icons.lock_outline, size: 12, color: colors.onSurfaceVariant),
            ],
          ),
        ),
      ),
    );
  }
}

/// A wider inert "later" affordance for a state card (the ended session's
/// recording, the empty state's scheduled sessions): looks like a disabled
/// action, carries the «غير متاح الآن» tag, and does nothing.
class LiveSoonAction extends StatelessWidget {
  const LiveSoonAction({super.key, required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Semantics(
      enabled: false,
      label: '$label — ${LiveCopy.soonBadge}',
      child: Opacity(
        opacity: 0.55,
        child: Container(
          padding: const EdgeInsets.symmetric(
            horizontal: Insets.lg,
            vertical: Insets.md,
          ),
          decoration: BoxDecoration(
            borderRadius: Radii.pill,
            border: Border.all(color: colors.outline),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 18, color: colors.onSurfaceVariant),
              const SizedBox(width: Insets.sm),
              Flexible(
                child: Text(
                  label,
                  style: context.text.labelLarge,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: Insets.sm),
              Text(
                LiveCopy.soonBadge,
                style: context.text.labelSmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

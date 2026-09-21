import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/mock_ribbon.dart';
import '../../../core/widgets/foundations/stat_badge.dart';
import '../../../core/widgets/patterns/program_icons.dart';
import '../../../data/models/program.dart';

/// The reference's featured-program card: a visual panel on the right, content
/// on the left, a badge, title, subtitle, a meta row, and a navigation cue.
///
/// The featured item is قسم التهجي — the profile itself calls it
/// "أقوى قسم في المؤسسة" (page 7), which honestly fills the reference's
/// "most popular" star slot. Every string and figure is real; there is no
/// invented popularity metric.
class HomeFeaturedCard extends StatelessWidget {
  const HomeFeaturedCard({super.key, required this.program, required this.onOpen});

  final Program program;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    // Real superlative from the description's first clause: "أقوى قسم في المؤسسة".
    final badge = (program.description ?? '').split('،').first.trim();

    return AppCard(
      elevated: true,
      onTap: onOpen,
      borderRadius: Radii.brXl,
      padding: EdgeInsets.zero,
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Visual panel — first child, so it sits on the right under RTL,
            // matching the reference. Placeholder for a future program image.
            _VisualPanel(iconName: program.iconName),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(Insets.lg),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    if (badge.isNotEmpty) ...[
                      Wrap(
                        spacing: Insets.sm,
                        runSpacing: Insets.sm,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          StatBadge(
                            label: badge,
                            icon: Icons.star_rounded,
                            tone: StatBadgeTone.soft,
                          ),
                          const SourceChip(page: 7),
                        ],
                      ),
                      const SizedBox(height: Insets.md),
                    ],
                    Text(program.name, style: context.text.titleLarge),
                    if (program.description != null) ...[
                      const SizedBox(height: Insets.xs),
                      Text(
                        program.description!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.bodySmall,
                      ),
                    ],
                    const SizedBox(height: Insets.md),
                    _MetaRow(program: program),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _VisualPanel extends StatelessWidget {
  const _VisualPanel({required this.iconName});

  final String iconName;

  @override
  Widget build(BuildContext context) {
    final onBrand = context.colors.onPrimary;
    // A plain solid-green panel (not a ContourBand): CustomPaint does not
    // support the intrinsic-size pass this card's IntrinsicHeight needs.
    // Branded placeholder for a future program image.
    return Container(
      width: 108,
      decoration: BoxDecoration(
        color: context.colors.primary,
        borderRadius: const BorderRadiusDirectional.horizontal(start: Radii.lg)
            .resolve(TextDirection.rtl),
      ),
      padding: const EdgeInsets.all(Insets.md),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: onBrand.withValues(alpha: 0.18),
              borderRadius: Radii.brMd,
            ),
            child: Icon(programIcon(iconName), color: onBrand, size: 24),
          ),
          const SizedBox(height: Insets.md),
          // Decorative navigation cue — the whole card is the tap target.
          ExcludeSemantics(
            child: Container(
              width: 32,
              height: 32,
              decoration: BoxDecoration(
                color: onBrand.withValues(alpha: 0.18),
                shape: BoxShape.circle,
              ),
              // Auto-mirrors under RTL to point left (the forward cue).
              child: Icon(Icons.chevron_right_rounded, color: onBrand, size: 22),
            ),
          ),
        ],
      ),
    );
  }
}

class _MetaRow extends StatelessWidget {
  const _MetaRow({required this.program});

  final Program program;

  @override
  Widget build(BuildContext context) {
    final items = <(IconData, String)>[
      if (program.capacityNote != null)
        (Icons.groups_2_outlined, program.capacityNote!),
      if (program.items.isNotEmpty)
        (Icons.format_list_bulleted_rounded, '${program.items.length} عناصر'),
      (Icons.workspace_premium_outlined, 'قسم خاص'),
    ];

    // A plain Wrap (no LayoutBuilder): RenderWrap supports the intrinsic-size
    // pass that this card's IntrinsicHeight needs, and it already hands each
    // child a maxWidth equal to the available width, so the Flexible text
    // ellipsizes instead of overflowing.
    return Wrap(
      spacing: Insets.lg,
      runSpacing: Insets.sm,
      children: [
        for (final (icon, label) in items)
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 16, color: context.colors.onSurfaceVariant),
              const SizedBox(width: Insets.xs),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.labelMedium,
                ),
              ),
            ],
          ),
      ],
    );
  }
}

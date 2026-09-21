import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/stat_badge.dart';
import '../../../data/models/program.dart';

/// The reference's featured-program card: content on the right (RTL start) — a
/// badge, title, description and a meta row — with a visual panel on the left.
///
/// The featured item is قسم التهجي; the profile itself calls it
/// "أقوى قسم في المؤسسة" (page 7), which honestly fills the reference's
/// "most popular" badge. Every string and figure is real; there is no invented
/// popularity metric, and the meta figures come straight from the program.
class HomeFeaturedCard extends StatelessWidget {
  const HomeFeaturedCard({
    super.key,
    required this.program,
    required this.onOpen,
  });

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
      child: ClipRRect(
        borderRadius: Radii.brXl,
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Content first → sits on the right (start) under RTL.
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.all(Insets.lg),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      if (badge.isNotEmpty) ...[
                        Align(
                          alignment: AlignmentDirectional.centerStart,
                          child: StatBadge(
                            label: badge,
                            icon: Icons.star_rounded,
                            tone: StatBadgeTone.primary,
                          ),
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
                          style: context.text.bodySmall
                              ?.copyWith(color: context.colors.onSurfaceVariant),
                        ),
                      ],
                      const SizedBox(height: Insets.md),
                      _MetaRow(program: program),
                    ],
                  ),
                ),
              ),
              // Visual panel last → sits on the left (end) under RTL, matching
              // the reference's image-on-the-left composition.
              const _VisualPanel(),
            ],
          ),
        ),
      ),
    );
  }
}

class _VisualPanel extends StatelessWidget {
  const _VisualPanel();

  @override
  Widget build(BuildContext context) {
    final onBrand = context.colors.onPrimary;
    // A warm green panel with a Quran motif — a branded placeholder for a
    // future program photo (swap for Image.asset without touching the layout).
    return Container(
      width: 116,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            context.colors.primary,
            Color.alphaBlend(Colors.black.withValues(alpha: 0.18),
                context.colors.primary),
          ],
        ),
      ),
      child: Stack(
        alignment: Alignment.center,
        children: [
          Icon(Icons.menu_book_rounded,
              size: 46, color: onBrand.withValues(alpha: 0.9)),
          // Decorative navigation cue — the whole card is the tap target.
          Align(
            alignment: AlignmentDirectional.bottomCenter,
            child: Padding(
              padding: const EdgeInsets.only(bottom: Insets.md),
              child: ExcludeSemantics(
                child: Container(
                  width: 34,
                  height: 34,
                  decoration: BoxDecoration(
                    color: onBrand.withValues(alpha: 0.22),
                    shape: BoxShape.circle,
                  ),
                  // Auto-mirrors under RTL to point left (the forward cue).
                  child: Icon(Icons.arrow_forward_rounded,
                      color: onBrand, size: 20),
                ),
              ),
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

    // A plain Wrap (RenderWrap supports the intrinsic pass this card's
    // IntrinsicHeight needs, and bounds each child to the available width).
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
                  style: context.text.labelMedium
                      ?.copyWith(color: context.colors.onSurfaceVariant),
                ),
              ),
            ],
          ),
      ],
    );
  }
}

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

  // A replaceable prototype photo; the crop is biased toward the mushaf, which
  // sits left of centre in the source image.
  static const _asset = 'assets/images/featured_quran.jpg';

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 116,
      child: Stack(
        fit: StackFit.expand,
        children: [
          Image.asset(
            _asset,
            fit: BoxFit.cover,
            alignment: const Alignment(-0.2, 0),
            errorBuilder: (context, error, stack) =>
                ColoredBox(color: context.colors.primary),
          ),
          // A soft bottom scrim so the cue reads over the photo.
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.center,
                end: Alignment.bottomCenter,
                colors: [Colors.transparent, Color(0x59000000)],
              ),
            ),
          ),
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
                    color: context.colors.primary,
                    shape: BoxShape.circle,
                    border: Border.all(color: Colors.white, width: 1.5),
                  ),
                  // Auto-mirrors under RTL to point left (the forward cue).
                  child: const Icon(Icons.arrow_forward_rounded,
                      color: Colors.white, size: 18),
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

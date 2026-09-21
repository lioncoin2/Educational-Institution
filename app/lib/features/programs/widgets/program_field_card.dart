import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../home/widgets/home_palette.dart';

/// One compact program card in the reference's grid: a photo strip with a
/// floating icon badge, and the field's title below.
///
/// The title is a real study field (`institution.fields`, profile page 5). The
/// photo is a replaceable prototype asset resolved from [assetPath]; until it is
/// supplied the card shows a soft coloured panel so it never renders blank.
class ProgramFieldCard extends StatelessWidget {
  const ProgramFieldCard({
    super.key,
    required this.title,
    required this.icon,
    required this.assetPath,
    required this.tone,
    required this.onTap,
  });

  final String title;
  final IconData icon;
  final String assetPath;
  final HomeTileTone tone;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = HomePalette.tile(context, tone);

    // No semanticLabel: AppCard's InkWell merges the subtree into one node and
    // the title Text already announces it.
    return AppCard(
      onTap: onTap,
      padding: EdgeInsets.zero,
      child: ClipRRect(
        borderRadius: Radii.brLg,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Photo strip with a floating icon badge.
            SizedBox(
              height: 66,
              child: Stack(
                children: [
                  Positioned.fill(
                    child: Image.asset(
                      assetPath,
                      fit: BoxFit.cover,
                      errorBuilder: (context, error, stack) =>
                          ColoredBox(color: c.background),
                    ),
                  ),
                  PositionedDirectional(
                    bottom: Insets.sm,
                    end: Insets.sm,
                    child: Container(
                      width: 34,
                      height: 34,
                      decoration: BoxDecoration(
                        color: context.colors.surfaceContainerLowest,
                        shape: BoxShape.circle,
                        boxShadow: context.isDark ? null : Shadows.card,
                      ),
                      child: Icon(icon, size: 18, color: c.foreground),
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(Insets.md),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: context.text.titleSmall
                          ?.copyWith(fontWeight: FontWeight.w700),
                    ),
                  ),
                  const SizedBox(width: Insets.xs),
                  // Auto-mirrors under RTL to point left (the forward cue).
                  Icon(Icons.arrow_forward_rounded,
                      size: 18, color: context.colors.onSurfaceVariant),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

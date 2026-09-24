import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/stat_badge.dart';
import '../../../data/models/communities.dart';
import '../community_copy.dart';

/// One row of «مجتمعاتي»: the community, how many are in it, whether it is
/// locked, and where the viewer stands in it.
///
/// The figures sit in a [Wrap], so at the largest text scale on a small
/// phone they move to a second line instead of overflowing.
class CommunityTile extends StatelessWidget {
  const CommunityTile({
    super.key,
    required this.community,
    required this.onTap,
  });

  final Community community;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      onTap: onTap,
      padding: const EdgeInsets.all(Insets.md),
      semanticLabel: CommunityCopy.communityLabel(community),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 44,
            height: 44,
            alignment: AlignmentDirectional.center,
            decoration: BoxDecoration(
              color: context.colors.primaryContainer,
              shape: BoxShape.circle,
            ),
            child: Icon(
              Icons.groups_2_outlined,
              size: 22,
              color: context.colors.onPrimaryContainer,
            ),
          ),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  community.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.titleSmall,
                ),
                const SizedBox(height: Insets.xs),
                Wrap(
                  spacing: Insets.sm,
                  runSpacing: Insets.xs,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(
                      CommunityCopy.members(community.memberCount),
                      style: context.text.bodySmall,
                    ),
                    Text(
                      CommunityCopy.standing(community.me),
                      style: context.text.labelSmall?.copyWith(
                        color: context.colors.primary,
                      ),
                    ),
                    if (community.isLocked)
                      const StatBadge(
                        label: CommunityCopy.locked,
                        icon: Icons.lock_outline_rounded,
                        tone: StatBadgeTone.soft,
                      ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

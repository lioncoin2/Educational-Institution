import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_avatar.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/stat_badge.dart';
import '../../../data/models/communities.dart';
import '../community_copy.dart';
import '../state/community_controller.dart';

/// One row of «مجتمعاتي»: the community's picture, its title, how many are in
/// it, whether it is locked, and where the viewer stands in it.
///
/// The picture is the community's own avatar — the same image the detail page,
/// the chat header, and the edit sheet show — resolved through the existing
/// short-lived signed link ([communityAvatarUrlProvider]); a community without
/// a picture, or one whose link fails, falls back to its initial (AppAvatar),
/// so the card never waits on an image or shows a gap. The fetch is skipped
/// entirely for a picture-less community (its `avatarFileAssetId` is null on
/// every list item), so a list of them makes no avatar requests at all.
///
/// The figures sit in a [Wrap], so at the largest text scale on a small
/// phone they move to a second line instead of overflowing.
class CommunityTile extends ConsumerWidget {
  const CommunityTile({
    super.key,
    required this.community,
    required this.onTap,
  });

  final Community community;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final imageUrl = community.avatarFileAssetId == null
        ? null
        : ref.watch(communityAvatarUrlProvider(community.id)).value;
    return AppCard(
      onTap: onTap,
      padding: const EdgeInsets.all(Insets.md),
      semanticLabel: CommunityCopy.communityLabel(community),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AppAvatar(name: community.title, imageUrl: imageUrl, radius: 22),
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

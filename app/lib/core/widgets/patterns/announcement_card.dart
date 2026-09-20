import 'package:flutter/material.dart';

import '../../../data/models/feed.dart';
import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';
import '../foundations/app_card.dart';
import '../foundations/mock_ribbon.dart';

/// A post from قسم الإعلام والإعلان والتصاميم (profile page 11).
/// The three categories and the publishing channels are real; posts are mock.
class AnnouncementCard extends StatelessWidget {
  const AnnouncementCard({
    super.key,
    required this.announcement,
    this.compact = false,
  });

  final Announcement announcement;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      semanticLabel: announcement.title,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.sm,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              _CategoryChip(category: announcement.category),
              if (announcement.isPinned)
                Icon(Icons.push_pin_outlined,
                    size: 16, color: context.colors.primary),
              Text(announcement.dateLabel, style: context.text.labelSmall),
            ],
          ),
          const SizedBox(height: Insets.md),
          Text(announcement.title, style: context.text.titleSmall),
          const SizedBox(height: Insets.sm),
          Text(
            announcement.body,
            style: context.text.bodySmall,
            maxLines: compact ? 2 : 6,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: Insets.md),
          Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.sm,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              for (final channel in announcement.channels)
                _ChannelChip(label: channel),
              const MockChip(compact: true),
            ],
          ),
        ],
      ),
    );
  }
}

class _CategoryChip extends StatelessWidget {
  const _CategoryChip({required this.category});

  final AnnouncementCategory category;

  @override
  Widget build(BuildContext context) {
    final icon = switch (category) {
      AnnouncementCategory.informational => Icons.campaign_outlined,
      AnnouncementCategory.design => Icons.palette_outlined,
      AnnouncementCategory.coverage => Icons.photo_camera_outlined,
    };
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.md,
        vertical: Insets.xs,
      ),
      decoration: BoxDecoration(
        color: context.colors.primaryContainer,
        borderRadius: Radii.pill,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: context.colors.onPrimaryContainer),
          const SizedBox(width: Insets.xs),
          Flexible(
            child: Text(
              category.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.text.labelSmall?.copyWith(
                color: context.colors.onPrimaryContainer,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ChannelChip extends StatelessWidget {
  const _ChannelChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.md,
        vertical: Insets.xs,
      ),
      decoration: BoxDecoration(
        borderRadius: Radii.pill,
        border: Border.all(color: context.colors.outlineVariant),
      ),
      child: Text(label, style: context.text.labelSmall),
    );
  }
}

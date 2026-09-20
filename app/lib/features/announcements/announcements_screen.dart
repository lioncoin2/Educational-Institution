import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/patterns/announcement_card.dart';
import '../../data/models/feed.dart';
import '../../data/sources/profile_data.dart';
import '../../providers/app_providers.dart';

/// The learner-facing side of قسم الإعلام والإعلان والتصاميم (page 11).
/// Its three service lines become the filter chips.
class AnnouncementsScreen extends ConsumerStatefulWidget {
  const AnnouncementsScreen({super.key});

  @override
  ConsumerState<AnnouncementsScreen> createState() =>
      _AnnouncementsScreenState();
}

class _AnnouncementsScreenState extends ConsumerState<AnnouncementsScreen> {
  AnnouncementCategory? _filter;

  @override
  Widget build(BuildContext context) {
    final announcements = ref.watch(announcementsProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('الإعلانات')),
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: announcements,
          loading: const Center(child: CircularProgressIndicator()),
          builder: (context, all) {
            final list = _filter == null
                ? all
                : all.where((a) => a.category == _filter).toList();

            return CustomScrollView(
              slivers: [
                SliverGutter(child: const _MediaIntro()),

                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.only(top: Insets.lg),
                    child: SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      padding:
                          EdgeInsets.symmetric(horizontal: context.gutter),
                      child: Row(
                        children: [
                          _FilterChip(
                            label: 'الكل',
                            selected: _filter == null,
                            onTap: () => setState(() => _filter = null),
                          ),
                          for (final category
                              in AnnouncementCategory.values) ...[
                            const SizedBox(width: Insets.sm),
                            _FilterChip(
                              label: category.label,
                              selected: _filter == category,
                              onTap: () => setState(() => _filter = category),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),

                if (list.isEmpty)
                  const SliverToBoxAdapter(
                    child: EmptyState(
                      icon: Icons.campaign_outlined,
                      title: 'لا توجد إعلانات في هذا التصنيف',
                    ),
                  )
                else
                  SliverGutter(
                    top: Insets.lg,
                    bottom: Insets.giant,
                    child: Column(
                      children: [
                        for (final announcement in list)
                          Padding(
                            padding: const EdgeInsets.only(bottom: Insets.md),
                            child:
                                AnnouncementCard(announcement: announcement),
                          ),
                      ],
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _MediaIntro extends StatelessWidget {
  const _MediaIntro();

  @override
  Widget build(BuildContext context) {
    return AppCard(
      color: context.colors.surfaceContainerLow,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const CardTitleRow(
            title: 'قسم الإعلام والإعلان والتصاميم',
            trailing: SourceChip(page: 11),
          ),
          const SizedBox(height: Insets.md),
          Text(ProfileData.mediaDescription, style: context.text.bodySmall),
          const SizedBox(height: Insets.lg),
          Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.sm,
            children: [
              for (final channel in ProfileData.mediaChannels)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: Insets.md,
                    vertical: Insets.xs,
                  ),
                  decoration: BoxDecoration(
                    borderRadius: Radii.pill,
                    border: Border.all(color: context.colors.outlineVariant),
                  ),
                  child: Text(channel, style: context.text.labelSmall),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _FilterChip extends StatelessWidget {
  const _FilterChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) => onTap(),
      showCheckmark: false,
      selectedColor: context.colors.primary,
      labelStyle: context.text.labelMedium?.copyWith(
        color: selected ? context.colors.onPrimary : context.colors.onSurface,
        fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
      ),
    );
  }
}

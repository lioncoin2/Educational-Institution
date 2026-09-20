import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/mock_ribbon.dart';
import '../../../data/models/learning.dart';

/// The single most useful card on the home screen: what is next, and the way in.
class NextHalaqaCard extends StatelessWidget {
  const NextHalaqaCard({
    super.key,
    required this.halaqa,
    required this.onOpen,
  });

  final Halaqa halaqa;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      elevated: true,
      onTap: onOpen,
      semanticLabel: 'الحلقة القادمة: ${halaqa.name}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.sm,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: Insets.md,
                  vertical: Insets.xs,
                ),
                decoration: BoxDecoration(
                  color: context.colors.primaryContainer,
                  borderRadius: Radii.pill,
                ),
                child: Text(
                  'حلقتك القادمة',
                  style: context.text.labelSmall?.copyWith(
                    color: context.colors.onPrimaryContainer,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              const MockChip(compact: true),
            ],
          ),
          const SizedBox(height: Insets.lg),
          Text(halaqa.name, style: context.text.headlineMedium),
          const SizedBox(height: Insets.sm),
          _Meta(icon: Icons.schedule_rounded, text: halaqa.scheduleLabel),
          const SizedBox(height: Insets.sm),
          _Meta(
            icon: Icons.person_outline_rounded,
            text: halaqa.teacherName,
          ),
          const SizedBox(height: Insets.xl),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: onOpen,
                  icon: const Icon(Icons.play_arrow_rounded),
                  label: const Text('ادخلي الحلقة'),
                ),
              ),
              const SizedBox(width: Insets.md),
              IconButton.filledTonal(
                tooltip: 'مجموعة الحلقة',
                onPressed: () => context.toast(
                  'الربط بمجموعات واتساب وتلغرام خارج نطاق النموذج الأولي',
                ),
                icon: const Icon(Icons.chat_bubble_outline_rounded),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Meta extends StatelessWidget {
  const _Meta({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 16, color: context.colors.onSurfaceVariant),
        const SizedBox(width: Insets.xs),
        Expanded(
          child: Text(
            text,
            style: context.text.bodySmall,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}

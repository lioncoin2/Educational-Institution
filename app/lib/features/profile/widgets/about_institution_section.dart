import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/mock_ribbon.dart';
import '../../../core/widgets/foundations/section_header.dart';
import '../../../core/widgets/foundations/stat_badge.dart';
import '../../../core/widgets/patterns/info_row.dart';
import '../../../data/sources/profile_data.dart';

/// The institution in its own words. Every line here is from the profile PDF.
class AboutInstitutionSection extends StatelessWidget {
  const AboutInstitutionSection({super.key});

  @override
  Widget build(BuildContext context) {
    final institution = ProfileData.institution;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionHeader(
          title: 'عن المؤسسة',
          trailing: SourceChip(page: 3),
        ),
        const SizedBox(height: Insets.lg),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(institution.name, style: context.text.titleSmall),
              const SizedBox(height: Insets.md),
              Text(institution.about, style: context.text.bodyMedium),
              const SizedBox(height: Insets.lg),
              Wrap(
                spacing: Insets.sm,
                runSpacing: Insets.sm,
                children: const [
                  StatBadge(
                    label: 'مجانية بالكامل',
                    icon: Icons.volunteer_activism_outlined,
                    tone: StatBadgeTone.soft,
                  ),
                  StatBadge(
                    label: 'تعليم عن بُعد',
                    icon: Icons.public_rounded,
                    tone: StatBadgeTone.soft,
                  ),
                ],
              ),
            ],
          ),
        ),

        const SizedBox(height: Insets.lg),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const CardTitleRow(
                title: 'الفئات المستهدفة',
                trailing: SourceChip(page: 4),
              ),
              const SizedBox(height: Insets.xs),
              Text(
                ProfileData.targetGroupsSubtitle,
                style: context.text.bodySmall,
              ),
              const SizedBox(height: Insets.md),
              for (final group in institution.targetGroups)
                InfoRow(
                  icon: Icons.group_outlined,
                  label: group.name,
                  value: group.detail ?? '—',
                ),
            ],
          ),
        ),

        const SizedBox(height: Insets.lg),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const CardTitleRow(
                title: 'آفاق مستقبلية',
                trailing: SourceChip(page: 14),
              ),
              const SizedBox(height: Insets.md),
              BulletList(items: institution.futureHorizons, dense: true),
              const SizedBox(height: Insets.sm),
              Text(
                ProfileData.futureHorizonsClosing,
                style: context.text.bodyMedium?.copyWith(
                  fontStyle: FontStyle.italic,
                  color: context.colors.primary,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

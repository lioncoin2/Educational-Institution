import 'package:flutter/material.dart';

import '../../../data/models/certificate.dart';
import '../../extensions/context_ext.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_tokens.dart';
import '../foundations/app_card.dart';
import '../foundations/mock_ribbon.dart';

/// Certificate row. The three kinds are real (profile page 13); the records
/// themselves are mock.
class CertificateCard extends StatelessWidget {
  const CertificateCard({super.key, required this.certificate, this.onTap});

  final Certificate certificate;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final issued = certificate.status == CertificateStatus.issued;

    return AppCard(
      onTap: onTap,
      semanticLabel: '${certificate.kind.label}: ${certificate.title}',
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Seal(kind: certificate.kind, issued: issued),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(certificate.kind.label, style: context.text.labelSmall),
                const SizedBox(height: 2),
                Text(
                  certificate.title,
                  style: context.text.titleSmall,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: Insets.sm),
                Row(
                  children: [
                    Icon(
                      issued
                          ? Icons.verified_outlined
                          : Icons.hourglass_bottom_rounded,
                      size: 14,
                      color: issued
                          ? context.colors.tertiary
                          : context.colors.onSurfaceVariant,
                    ),
                    const SizedBox(width: Insets.xs),
                    Expanded(
                      child: Text(
                        issued
                            ? certificate.issuedLabel
                            : (certificate.progressNote ?? 'قيد الإصدار'),
                        style: context.text.labelSmall,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: Insets.md),
                const MockChip(compact: true),
              ],
            ),
          ),
          if (onTap != null)
            Icon(Icons.chevron_right_rounded,
                color: context.colors.onSurfaceVariant),
        ],
      ),
    );
  }
}

/// The gold seal. Gold on a dark plum disc only — gold text on a light
/// background fails contrast (2.54:1), so it is never used that way.
class _Seal extends StatelessWidget {
  const _Seal({required this.kind, required this.issued});

  final CertificateKind kind;
  final bool issued;

  @override
  Widget build(BuildContext context) {
    final icon = switch (kind) {
      CertificateKind.educational => Icons.school_outlined,
      CertificateKind.appreciation => Icons.star_outline_rounded,
      CertificateKind.ijazah => Icons.auto_awesome_outlined,
    };

    return Container(
      width: 52,
      height: 52,
      decoration: BoxDecoration(
        color: issued ? AppColors.primaryDeep : context.colors.surfaceContainerHigh,
        shape: BoxShape.circle,
        border: Border.all(
          color: issued
              ? AppColors.accentGold
              : context.colors.outlineVariant,
          width: 2,
        ),
      ),
      child: Icon(
        icon,
        size: 24,
        color: issued ? AppColors.accentGold : context.colors.onSurfaceVariant,
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/layout/contour_background.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../core/widgets/patterns/info_row.dart';
import '../../data/models/certificate.dart';
import '../../data/sources/profile_data.dart';
import '../../providers/app_providers.dart';

/// Certificate preview. Page 13 describes issuing, documenting and archiving —
/// this screen shows what a record would look like. Nothing is downloadable
/// or verifiable: there is no system behind it yet.
class CertificateDetailScreen extends ConsumerWidget {
  const CertificateDetailScreen({super.key, required this.certificateId});

  final String certificateId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final certificate = ref.watch(certificateProvider(certificateId));

    return Scaffold(
      appBar: AppBar(title: const Text('تفاصيل الشهادة')),
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: certificate,
          loading: const Center(child: CircularProgressIndicator()),
          builder: (context, data) {
            if (data == null) {
              return const EmptyState(
                icon: Icons.search_off_rounded,
                title: 'لم نجد هذه الشهادة',
              );
            }
            return _Body(certificate: data);
          },
        ),
      ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.certificate});

  final Certificate certificate;

  @override
  Widget build(BuildContext context) {
    final issued = certificate.status == CertificateStatus.issued;

    return CustomScrollView(
      slivers: [
        SliverGutter(child: _Preview(certificate: certificate)),

        SliverGutter(
          top: Insets.xl,
          child: AppCard(
            color: context.colors.surfaceContainerLow,
            child: Column(
              children: [
                InfoRow(
                  icon: Icons.category_outlined,
                  label: 'نوع الوثيقة',
                  value: certificate.kind.label,
                ),
                InfoRow(
                  icon: Icons.school_outlined,
                  label: 'البرنامج',
                  value: certificate.programName,
                ),
                InfoRow(
                  icon: issued
                      ? Icons.event_available_outlined
                      : Icons.hourglass_bottom_rounded,
                  label: issued ? 'تاريخ الإصدار' : 'الحالة',
                  value: issued
                      ? certificate.issuedLabel
                      : (certificate.progressNote ?? 'قيد الإصدار'),
                ),
                InfoRow(
                  icon: Icons.tag_rounded,
                  label: 'رقم التوثيق',
                  value: certificate.referenceCode,
                ),
              ],
            ),
          ),
        ),

        SliverGutter(
          top: Insets.xl,
          child: AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const CardTitleRow(
                  title: 'عن قسم الشهادات',
                  trailing: SourceChip(page: 13),
                ),
                const SizedBox(height: Insets.md),
                Text(
                  ProfileData.certificatesDescription,
                  style: context.text.bodyMedium,
                ),
              ],
            ),
          ),
        ),

        SliverGutter(
          top: Insets.xl,
          child: const MockBanner(
            message:
                'هذه شهادة تجريبية. أنواع الوثائق الثلاثة مأخوذة من الملف '
                'التعريفي، أما السجل ورقم التوثيق فمن صنع النموذج الأولي. '
                'التحقّق والتنزيل يحتاجان نظاماً حقيقياً.',
          ),
        ),

        SliverGutter(
          top: Insets.xl,
          bottom: Insets.giant,
          child: Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => context.toast(
                    'التحقّق من الشهادات خارج نطاق النموذج الأولي',
                  ),
                  icon: const Icon(Icons.verified_outlined, size: 18),
                  label: const Text('تحقّق'),
                ),
              ),
              const SizedBox(width: Insets.md),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => context.toast(
                    'تنزيل الشهادات خارج نطاق النموذج الأولي',
                  ),
                  icon: const Icon(Icons.download_outlined, size: 18),
                  label: const Text('تنزيل'),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// A restrained certificate face — gold on deep plum, where the gold actually
/// passes contrast (7.40:1).
class _Preview extends StatelessWidget {
  const _Preview({required this.certificate});

  final Certificate certificate;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: Radii.brLg,
      child: ContourBand(
        background: AppColors.primaryDeep,
        lineColor: AppColors.accentGold,
        opacity: 0.16,
        padding: const EdgeInsets.all(Insets.xxl),
        child: ResponsiveBody(
          horizontalPadding: false,
          child: Column(
            children: [
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border:
                      Border.all(color: AppColors.accentGold, width: 2),
                ),
                child: const Icon(
                  Icons.menu_book_rounded,
                  color: AppColors.accentGold,
                  size: 30,
                ),
              ),
              const SizedBox(height: Insets.lg),
              Text(
                ProfileData.institution.shortName,
                textAlign: TextAlign.center,
                style: context.text.labelMedium
                    ?.copyWith(color: AppColors.accentGold),
              ),
              const SizedBox(height: Insets.xl),
              Text(
                certificate.kind.label,
                style: context.text.bodyMedium
                    ?.copyWith(color: Colors.white70),
              ),
              const SizedBox(height: Insets.sm),
              Text(
                certificate.title,
                textAlign: TextAlign.center,
                style: context.text.headlineMedium
                    ?.copyWith(color: Colors.white),
              ),
              const SizedBox(height: Insets.xl),
              Container(
                width: 80,
                height: 2,
                color: AppColors.accentGold,
              ),
              const SizedBox(height: Insets.lg),
              Text(
                certificate.status == CertificateStatus.issued
                    ? certificate.referenceCode
                    : 'قيد الإصدار',
                style: context.text.labelSmall
                    ?.copyWith(color: Colors.white54, letterSpacing: 1),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

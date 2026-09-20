import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../core/widgets/patterns/certificate_card.dart';
import '../../data/models/certificate.dart';
import '../../data/sources/profile_data.dart';
import '../../providers/app_providers.dart';

/// The three document kinds named on page 13, as three tabs.
class CertificatesScreen extends ConsumerWidget {
  const CertificatesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final certificates = ref.watch(certificatesProvider);

    return DefaultTabController(
      length: CertificateKind.values.length,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('الشهادات والإجازات'),
          automaticallyImplyLeading: false,
          bottom: TabBar(
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            dividerColor: context.colors.outlineVariant,
            tabs: [
              for (final kind in CertificateKind.values)
                Tab(text: kind.label),
            ],
          ),
        ),
        body: SafeArea(
          top: false,
          child: AsyncView(
            value: certificates,
            loading: const Center(child: CircularProgressIndicator()),
            builder: (context, all) => TabBarView(
              children: [
                for (final kind in CertificateKind.values)
                  _KindTab(
                    kind: kind,
                    items: all.where((c) => c.kind == kind).toList(),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _KindTab extends StatelessWidget {
  const _KindTab({required this.kind, required this.items});

  final CertificateKind kind;
  final List<Certificate> items;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) {
      return EmptyState(
        icon: Icons.workspace_premium_outlined,
        title: 'لا توجد ${kind.label} بعد',
        message: 'ستظهر هنا عند إتمام البرامج المرتبطة بها.',
      );
    }

    final issued =
        items.where((c) => c.status == CertificateStatus.issued).toList();
    final pending =
        items.where((c) => c.status == CertificateStatus.inProgress).toList();

    return ListView(
      padding: EdgeInsets.only(
        top: Insets.lg,
        bottom: Insets.giant,
      ),
      children: [
        ResponsiveBody(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _SourceNote(),
              const SizedBox(height: Insets.lg),
              if (issued.isNotEmpty) ...[
                Text('صادرة', style: context.text.titleSmall),
                const SizedBox(height: Insets.md),
                for (final certificate in issued)
                  Padding(
                    padding: const EdgeInsets.only(bottom: Insets.md),
                    child: CertificateCard(
                      certificate: certificate,
                      onTap: () =>
                          context.go(Routes.certificate(certificate.id)),
                    ),
                  ),
              ],
              if (pending.isNotEmpty) ...[
                const SizedBox(height: Insets.lg),
                Text('قيد الإصدار', style: context.text.titleSmall),
                const SizedBox(height: Insets.md),
                for (final certificate in pending)
                  Padding(
                    padding: const EdgeInsets.only(bottom: Insets.md),
                    child: CertificateCard(
                      certificate: certificate,
                      onTap: () =>
                          context.go(Routes.certificate(certificate.id)),
                    ),
                  ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _SourceNote extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          ProfileData.certificatesDescription,
          style: context.text.bodySmall,
        ),
        const SizedBox(height: Insets.md),
        const Wrap(
          spacing: Insets.sm,
          runSpacing: Insets.sm,
          children: [
            SourceChip(page: 13),
            MockChip(label: 'السجلات تجريبية', compact: true),
          ],
        ),
      ],
    );
  }
}

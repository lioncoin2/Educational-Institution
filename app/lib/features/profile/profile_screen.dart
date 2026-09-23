import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/app_config.dart';
import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/foundations/unread_badge.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../core/widgets/layout/contour_background.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../core/widgets/patterns/info_row.dart';
import '../../data/models/student.dart';
import '../../providers/app_providers.dart';
import '../notifications/state/unread_count_controller.dart';
import 'widgets/about_institution_section.dart';

/// The learner's account, appearance settings, and the institution's own
/// information straight from the profile.
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final student = ref.watch(studentProvider);
    final themeMode = ref.watch(themeModeProvider);
    final textScale = ref.watch(textScaleProvider);
    final unreadNotifications = ref.watch(unreadNotificationCountProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('حسابي'),
        automaticallyImplyLeading: false,
      ),
      body: SafeArea(
        top: false,
        child: CustomScrollView(
          slivers: [
            SliverToBoxAdapter(
              child: AsyncView(
                value: student,
                loading: const SizedBox(height: 160),
                builder: (context, data) => ContourBand(
                  background: context.colors.primary,
                  lineColor: context.colors.onPrimary,
                  opacity: 0.14,
                  borderRadius:
                      const BorderRadius.vertical(bottom: Radii.xl),
                  padding: const EdgeInsets.only(
                    top: Insets.sm,
                    bottom: Insets.xxl,
                  ),
                  child: ResponsiveBody(
                    child: Column(
                      children: [
                        CircleAvatar(
                          radius: 36,
                          backgroundColor:
                              context.colors.onPrimary.withValues(alpha: 0.18),
                          child: Text(
                            data.initials,
                            style: context.text.headlineMedium
                                ?.copyWith(color: context.colors.onPrimary),
                          ),
                        ),
                        const SizedBox(height: Insets.md),
                        Text(
                          data.name,
                          style: context.text.headlineMedium
                              ?.copyWith(color: context.colors.onPrimary),
                        ),
                        // Only what the record holds: a real account has no
                        // target group on file, and may be enrolled nowhere.
                        if (_summary(data) case final summary?) ...[
                          const SizedBox(height: Insets.xs),
                          Text(
                            summary,
                            textAlign: TextAlign.center,
                            style: context.text.bodySmall?.copyWith(
                              color: context.colors.onPrimary
                                  .withValues(alpha: 0.78),
                            ),
                          ),
                        ],
                        if (data.origin.isMock) ...[
                          const SizedBox(height: Insets.md),
                          const MockChip(
                            label: 'ملف طالبة تجريبي',
                            compact: true,
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),

            // ── روابط سريعة ────────────────────────────────────────────
            SliverGutter(
              top: Insets.xxl,
              child: AppCard(
                padding: EdgeInsets.zero,
                child: Column(
                  children: [
                    _NavRow(
                      icon: Icons.insights_rounded,
                      label: 'تقدّمي',
                      onTap: () => context.push(Routes.progress),
                    ),
                    const Divider(indent: Insets.giant),
                    _NavRow(
                      icon: Icons.stairs_rounded,
                      label: 'مساري التعليمي',
                      onTap: () => context.go(Routes.path),
                    ),
                    const Divider(indent: Insets.giant),
                    _NavRow(
                      icon: Icons.workspace_premium_outlined,
                      label: 'الشهادات والإجازات',
                      onTap: () => context.go(Routes.certificates),
                    ),
                    const Divider(indent: Insets.giant),
                    _NavRow(
                      icon: Icons.campaign_outlined,
                      label: 'الإعلانات',
                      onTap: () => context.push(Routes.announcements),
                    ),
                    const Divider(indent: Insets.giant),
                    _NavRow(
                      icon: Icons.notifications_none_rounded,
                      label: 'الإشعارات',
                      badge: unreadNotifications,
                      onTap: () => context.push(Routes.notifications),
                    ),
                    const Divider(indent: Insets.giant),
                    _NavRow(
                      icon: Icons.forum_outlined,
                      label: 'الرسائل',
                      onTap: () => context.push(Routes.messages),
                    ),
                  ],
                ),
              ),
            ),

            // ── العرض ──────────────────────────────────────────────────
            SliverGutter(
              top: Insets.xxl,
              child: const SectionHeader(title: 'العرض'),
            ),
            SliverGutter(
              top: Insets.lg,
              child: AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      value: themeMode == ThemeMode.dark,
                      onChanged: (_) =>
                          ref.read(themeModeProvider.notifier).toggle(),
                      title: Text('الوضع الليلي',
                          style: context.text.titleSmall),
                      subtitle: Text(
                        'مستوحى من الصفحات الداكنة في الملف التعريفي',
                        style: context.text.bodySmall,
                      ),
                    ),
                    const Divider(),
                    const SizedBox(height: Insets.md),
                    Text('حجم الخط', style: context.text.titleSmall),
                    const SizedBox(height: Insets.xs),
                    Text(
                      'الفئات المستهدفة تشمل كبار السن ومحو الأمية، '
                      'فحجم الخط خيار أساسي.',
                      style: context.text.bodySmall,
                    ),
                    const SizedBox(height: Insets.md),
                    SegmentedButton<double>(
                      showSelectedIcon: false,
                      segments: const [
                        ButtonSegment(value: 1.0, label: Text('عادي')),
                        ButtonSegment(value: 1.15, label: Text('كبير')),
                        ButtonSegment(value: 1.3, label: Text('أكبر')),
                      ],
                      selected: {textScale},
                      onSelectionChanged: (values) => ref
                          .read(textScaleProvider.notifier)
                          .set(values.first),
                    ),
                  ],
                ),
              ),
            ),

            // ── عن المؤسسة ─────────────────────────────────────────────
            const SliverGutter(
              top: Insets.xxl,
              child: AboutInstitutionSection(),
            ),

            // ── حدود النموذج الأولي ────────────────────────────────────
            SliverGutter(
              top: Insets.xxl,
              bottom: Insets.giant,
              child: AppCard(
                color: context.colors.surfaceContainerLow,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(Icons.science_outlined,
                            size: 18, color: context.colors.onSurfaceVariant),
                        const SizedBox(width: Insets.sm),
                        Expanded(
                          child: Text(AppConfig.stageLabel,
                              style: context.text.titleSmall),
                        ),
                      ],
                    ),
                    const SizedBox(height: Insets.md),
                    Text(
                      'هذه النسخة واجهات فقط: لا يوجد تسجيل دخول ولا خادم '
                      'ولا قاعدة بيانات ولا خدمات خارجية. كل بيان غير موجود '
                      'في الملف التعريفي معلَّم بشارة «بيانات تجريبية».',
                      style: context.text.bodySmall,
                    ),
                    const SizedBox(height: Insets.lg),
                    InfoRow(
                      icon: Icons.contact_page_outlined,
                      label: 'بيانات التواصل',
                      value: 'غير واردة في الملف التعريفي',
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// "target group · where they study", from whichever parts are known.
String? _summary(StudentProfile student) {
  final parts = [
    ?student.targetGroupName,
    ?student.currentProgramName,
  ];
  return parts.isEmpty ? null : parts.join(' · ');
}

class _NavRow extends StatelessWidget {
  const _NavRow({
    required this.icon,
    required this.label,
    required this.onTap,
    this.badge = 0,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  /// An unread count shown before the chevron (see [UnreadBadge]).
  final int badge;

  @override
  Widget build(BuildContext context) {
    final chevron = Icon(Icons.chevron_right_rounded,
        color: context.colors.onSurfaceVariant);
    return ListTile(
      onTap: onTap,
      leading: Icon(icon, color: context.colors.primary),
      title: Text(label, style: context.text.titleSmall),
      trailing: badge > 0
          ? Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                UnreadBadge(count: badge),
                const SizedBox(width: Insets.xs),
                chevron,
              ],
            )
          : chevron,
      shape: const RoundedRectangleBorder(borderRadius: Radii.brLg),
    );
  }
}

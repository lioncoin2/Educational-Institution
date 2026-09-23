import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../providers/app_providers.dart';
import '../notifications/state/unread_count_controller.dart';
import '../home/widgets/home_palette.dart';
import 'widgets/programs_bottom_cta.dart';
import 'widgets/programs_grid.dart';
import 'widgets/programs_header.dart';
import 'widgets/programs_hero.dart';
import 'widgets/programs_search_bar.dart';

/// The Programs screen, laid out to the reference composition: a centered
/// header, a short mosque hero, a search + filter row, a two-column grid of the
/// institution's six real study-fields, and a closing CTA.
///
/// Like Home, Programs wears the institution's emblem green via a [HomePalette]
/// Theme placed below the shared navigation shell, so the bottom-nav pill stays
/// plum and no other tab is touched. Every string and card is real institution
/// data; the card photos are replaceable prototype assets.
class ProgramsScreen extends ConsumerStatefulWidget {
  const ProgramsScreen({super.key});

  @override
  ConsumerState<ProgramsScreen> createState() => _ProgramsScreenState();
}

class _ProgramsScreenState extends ConsumerState<ProgramsScreen> {
  String _query = '';

  /// Each real study field opens a representative real program in that field, so
  /// the field grid stays a working entry point into the catalogue (fields have
  /// no detail page of their own). Keyed by the real study-field id.
  static const _fieldTarget = <String, String>{
    'f1': 'prog-hifz-city', // القرآن حفظاً وإتقاناً → مدينة الحفاظ
    'f2': 'prog-maqari', // العلوم الشرعية → المقارئ
    'f3': 'dep-tajweed-2', // التجويد والقراءات → قسم تجويد متوسط
    'f4': 'prog-nahw', // علوم اللغة والنحو → علوم النحو
    'f5': 'prog-mutun', // قسم المتون العلمية → المتون
    'f6': 'sec-languages', // قسم التعليم الدولي → قسم اللغات
  };

  @override
  Widget build(BuildContext context) {
    final institution = ref.watch(institutionProvider);
    final unread = ref.watch(unreadNotificationCountProvider);

    final fields = institution.value?.fields;
    final query = _query.trim();
    final visible = fields == null
        ? null
        : (query.isEmpty
            ? fields
            : fields.where((f) => f.name.contains(query)).toList());

    return Theme(
      data: HomePalette.themeOf(context),
      child: Builder(
        builder: (context) => Scaffold(
          body: SafeArea(
            bottom: false,
            child: CustomScrollView(
              slivers: [
                SliverGutter(
                  top: Insets.sm,
                  child: ProgramsHeader(
                    title: 'البرامج التعليمية',
                    subtitle: institution.value?.mission ?? '',
                    unreadCount: unread,
                    onNotifications: () => context.push(Routes.notifications),
                    onProfile: () => context.go(Routes.profile),
                  ),
                ),

                // ── Hero banner ─────────────────────────────────────────
                SliverGutter(
                  top: Insets.md,
                  // Both lines are real institution content (profile "about").
                  child: const ProgramsHero(
                    headline: 'تعليمٌ أصيلٌ ومنهجٌ متدرّج',
                    support: 'مؤسسة عالمية عن بُعد، مجانية بالكامل',
                  ),
                ),

                // ── Search + filter ─────────────────────────────────────
                SliverGutter(
                  top: Insets.lg,
                  child: ProgramsSearchBar(
                    onChanged: (value) => setState(() => _query = value),
                    onFilter: () => context.toast('خيارات التصفية قريباً'),
                  ),
                ),

                // ── Grid of six real study-fields ───────────────────────
                SliverGutter(
                  top: Insets.lg,
                  child: visible == null
                      ? const SkeletonBox(height: 300)
                      : visible.isEmpty
                          ? const _EmptyResult()
                          : ProgramsGrid(
                              fields: visible,
                              onOpen: (field) => context.go(Routes.program(
                                  _fieldTarget[field.id] ?? 'dep-literacy')),
                            ),
                ),

                // ── Closing CTA ─────────────────────────────────────────
                SliverGutter(
                  top: Insets.xxl,
                  child: ProgramsBottomCta(
                    title: 'ابدأ رحلتك التعليمية الآن',
                    subtitle: 'تعليم أصيل ومنهج متدرّج وتأهيل متخصص',
                    buttonLabel: 'استكشف البرامج',
                    onExplore: () =>
                        context.go(Routes.program('dep-literacy')),
                  ),
                ),

                const SliverToBoxAdapter(child: SizedBox(height: Insets.giant)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _EmptyResult extends StatelessWidget {
  const _EmptyResult();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Insets.xxl),
      child: Column(
        children: [
          Icon(Icons.search_off_rounded,
              size: 32, color: context.colors.onSurfaceVariant),
          const SizedBox(height: Insets.sm),
          Text('لا توجد نتائج مطابقة', style: context.text.bodyMedium),
        ],
      ),
    );
  }
}

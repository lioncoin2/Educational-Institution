import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../data/models/institution.dart';
import '../../data/models/program.dart';
import '../../providers/app_providers.dart';
import '../notifications/state/unread_count_controller.dart';
import '../home/widgets/home_category_grid.dart';
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

  static const _departmentsTitle = 'الأقسام التعليمية';
  static const _specialsTitle = 'الأقسام الخاصة';
  static const _companionsTitle = 'البرامج المرافقة';
  static const _fieldUnlinked =
      'لا يرتبط هذا المجال ببرنامج بعد؛ اختر من الأقسام والبرامج أدناه.';

  @override
  Widget build(BuildContext context) {
    final institution = ref.watch(institutionProvider);
    final unread = ref.watch(unreadNotificationCountProvider);
    // The institution's REAL catalogue (the server's sections and programs in
    // backend mode) — what Home's «عرض جميع الأقسام/البرامج» promise this tab
    // shows (ST-02: «كل ما تقدّمه المؤسسة في شاشة واحدة»).
    final departments = ref.watch(departmentsProvider).value;
    final specials = ref.watch(specialSectionsProvider).value;
    final companions = ref.watch(companionProgramsProvider).value;
    final catalogue = [...?departments, ...?specials, ...?companions];
    final known = {for (final program in catalogue) program.id};

    final fields = institution.value?.fields;
    final query = _query.trim();
    final visible = fields == null
        ? null
        : (query.isEmpty
            ? fields
            : fields.where((f) => f.name.contains(query)).toList());
    List<Program>? matching(List<Program>? list) => list == null
        ? null
        : (query.isEmpty
            ? list
            : list.where((p) => p.name.contains(query)).toList());

    // A study field opens its representative program only when that program
    // is really in the catalogue: the field → program pairing is the demo
    // profile's, not a server link (Q38 is open), so against an institution's
    // own records it may name nothing — and must not lead to «لم نجد».
    void openField(StudyField field) {
      final target = _fieldTarget[field.id];
      if (target != null && known.contains(target)) {
        context.go(Routes.program(target));
      } else {
        context.toast(_fieldUnlinked);
      }
    }

    final exploreTarget = known.contains('dep-literacy')
        ? 'dep-literacy'
        : catalogue.firstOrNull?.id;

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
                          : ProgramsGrid(fields: visible, onOpen: openField),
                ),

                // ── The real catalogue: sections and programs ──────────
                for (final (title, list) in [
                  (_departmentsTitle, matching(departments)),
                  (_specialsTitle, matching(specials)),
                  (_companionsTitle, matching(companions)),
                ])
                  if (list != null && list.isNotEmpty) ...[
                    SliverGutter(
                      top: Insets.xl,
                      child: SectionHeader(title: title),
                    ),
                    SliverGutter(
                      top: Insets.md,
                      child: HomeCategoryGrid(
                        departments: list,
                        onOpen: (program) =>
                            context.go(Routes.program(program.id)),
                      ),
                    ),
                  ],

                // ── Closing CTA ─────────────────────────────────────────
                SliverGutter(
                  top: Insets.xxl,
                  child: ProgramsBottomCta(
                    title: 'ابدأ رحلتك التعليمية الآن',
                    subtitle: 'تعليم أصيل ومنهج متدرّج وتأهيل متخصص',
                    buttonLabel: 'استكشف البرامج',
                    // A program that exists — never a fixed code the
                    // institution's records may not have.
                    onExplore: () => exploreTarget == null
                        ? context.toast(_fieldUnlinked)
                        : context.go(Routes.program(exploreTarget)),
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

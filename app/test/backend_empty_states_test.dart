import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:quran_institution_app/core/widgets/foundations/empty_state.dart';
import 'package:quran_institution_app/core/widgets/foundations/mock_ribbon.dart';
import 'package:quran_institution_app/features/announcements/announcements_screen.dart';
import 'package:quran_institution_app/features/certificates/certificates_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// In a connected (backend / Trial) build, the always-mock seams resolve to the
/// empty server-mode repositories, so the screens show an honest empty state —
/// never the demo's invented certificates/announcements and never a mock chip.
Widget _host(Widget child) => ProviderScope(
  overrides: [backendModeProvider.overrideWithValue(true)],
  child: MaterialApp(locale: const Locale('ar'), home: child),
);

void main() {
  testWidgets('Certificates (backend): empty state, no mock marker', (
    tester,
  ) async {
    await tester.pumpWidget(_host(const CertificatesScreen()));
    await tester.pumpAndSettle();

    expect(find.byType(EmptyState), findsWidgets);
    expect(find.byType(MockChip), findsNothing);
    expect(find.textContaining('تجريبية'), findsNothing);
  });

  testWidgets('Announcements (backend): real media section + empty list, '
      'no mock marker', (tester) async {
    await tester.pumpWidget(_host(const AnnouncementsScreen()));
    await tester.pumpAndSettle();

    // The real institution media section (from the printed profile) still shows.
    expect(find.text('قسم الإعلام والإعلان والتصاميم'), findsOneWidget);
    // No invented posts and no mock marker.
    expect(find.byType(MockChip), findsNothing);
    expect(find.text('لا توجد إعلانات في هذا التصنيف'), findsOneWidget);
  });
}

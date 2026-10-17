import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/student/student_record_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// سجلّي الدراسي — the student's own enrollment record (`GET /academic/me/
/// enrollments`), every status, newest first. Read-only, identity-scoped. These
/// tests pin render (current + past with status/dates), the empty state, and a
/// load failure. Business logic stays in the controller; this drives it via a
/// fake repository.
class _FakeAcademic implements AcademicRepository {
  _FakeAcademic({this.page, this.error});

  final AcademicPage<PlacedEnrollment>? page;
  final Object? error;

  @override
  Future<AcademicPage<PlacedEnrollment>> myEnrollments({String? cursor}) async {
    if (error != null) throw error!;
    return page ?? const AcademicPage(items: []);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

PlacedEnrollment _enrollment(
  String halaqa,
  String status, {
  String? endedAt,
}) => PlacedEnrollment.fromJson({
  'enrollment': {
    'id': 'e-$halaqa',
    'studentUserId': 'me',
    'halaqaId': 'h-$halaqa',
    'status': status,
    'enrolledAt': '2026-09-01T00:00:00.000Z',
    'endedAt': ?endedAt,
  },
  'placement': {
    'section': {
      'id': 's1',
      'code': 'sec-1',
      'name': 'قسم التجويد',
      'order': 1,
      'status': 'ACTIVE',
      'kind': 'SPECIAL',
    },
    'program': {
      'id': 'p1',
      'code': 'prog-1',
      'name': 'برنامج الإتقان',
      'order': 1,
      'status': 'ACTIVE',
    },
    'halaqa': {
      'id': 'h-$halaqa',
      'code': 'hal',
      'name': halaqa,
      'order': 1,
      'status': 'ACTIVE',
    },
  },
});

Future<void> _pump(WidgetTester tester, _FakeAcademic academic) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        backendModeProvider.overrideWithValue(true),
        academicRepositoryProvider.overrideWithValue(academic),
      ],
      child: const MaterialApp(home: StudentRecordScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('lists current and past enrollments with status and dates', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeAcademic(
        page: AcademicPage(
          items: [
            _enrollment('حلقة الفجر', 'ACTIVE'),
            _enrollment(
              'حلقة المغرب',
              'COMPLETED',
              endedAt: '2026-10-01T00:00:00.000Z',
            ),
          ],
        ),
      ),
    );

    expect(find.text('حلقة الفجر'), findsOneWidget);
    expect(find.text('حلقة المغرب'), findsOneWidget);
    expect(find.text('نشط'), findsOneWidget); // ACTIVE
    expect(find.text('مكتمل'), findsOneWidget); // COMPLETED
    expect(find.text('قسم التجويد · برنامج الإتقان'), findsNWidgets(2));
    expect(find.textContaining('بدأ'), findsNWidgets(2)); // enrolled-on line
  });

  testWidgets('shows the empty state when there is no record', (tester) async {
    await _pump(tester, _FakeAcademic(page: const AcademicPage(items: [])));

    expect(find.text('لا سجلّ دراسي بعد'), findsOneWidget);
    expect(find.text('حلقة الفجر'), findsNothing);
  });

  testWidgets('shows an error with retry when the load fails', (tester) async {
    await _pump(
      tester,
      _FakeAcademic(
        error: const AcademicException('network.unreachable', 'offline'),
      ),
    );

    expect(find.widgetWithText(OutlinedButton, 'تحديث'), findsOneWidget);
    expect(find.text('حلقة الفجر'), findsNothing);
  });
}

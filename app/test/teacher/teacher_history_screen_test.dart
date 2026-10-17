import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/teacher/teacher_history_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// سجلّ إسناداتي — the teacher's own assignment record (`GET /academic/me/
/// teaching`), every status, newest first. Read-only, identity-scoped. These
/// tests pin render (current + past with role/status/dates), the empty state,
/// and a load failure. Business logic stays in the controller.
class _FakeAcademic implements AcademicRepository {
  _FakeAcademic({this.page, this.error});

  final AcademicPage<PlacedAssignment>? page;
  final Object? error;

  @override
  Future<AcademicPage<PlacedAssignment>> myTeaching({String? cursor}) async {
    if (error != null) throw error!;
    return page ?? const AcademicPage(items: []);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

PlacedAssignment _assignment(
  String halaqa,
  String status, {
  String role = 'TEACHER',
  String? endedAt,
}) => PlacedAssignment.fromJson({
  'assignment': {
    'id': 'a-$halaqa',
    'halaqaId': 'h-$halaqa',
    'teacherUserId': 'me',
    'role': role,
    'status': status,
    'startedAt': '2026-09-01T00:00:00.000Z',
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
      child: const MaterialApp(home: TeacherHistoryScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('lists current and past assignments with role, status, dates', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeAcademic(
        page: AcademicPage(
          items: [
            _assignment('حلقة الفجر', 'ACTIVE'),
            _assignment(
              'حلقة المغرب',
              'ENDED',
              role: 'ASSISTANT_TEACHER',
              endedAt: '2026-10-01T00:00:00.000Z',
            ),
          ],
        ),
      ),
    );

    expect(find.text('حلقة الفجر'), findsOneWidget);
    expect(find.text('حلقة المغرب'), findsOneWidget);
    expect(find.text('نشط'), findsOneWidget); // ACTIVE
    expect(find.text('منتهٍ'), findsOneWidget); // ENDED
    expect(find.text('قسم التجويد · برنامج الإتقان'), findsNWidgets(2));
    expect(find.textContaining('معلّم'), findsWidgets); // the role line
  });

  testWidgets('shows the empty state when there is no record', (tester) async {
    await _pump(tester, _FakeAcademic(page: const AcademicPage(items: [])));

    expect(find.text('لا سجلّ إسناد بعد'), findsOneWidget);
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

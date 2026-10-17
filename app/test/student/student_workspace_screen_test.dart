import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/student/student_workspace_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// حلقاتي — the student's own current enrollments, read-only, from
/// `GET /academic/me`. The screen shows each halaqa, where it sits, and its
/// teachers by name and role; it never shows classmates or controls. These
/// tests pin render, empty and error — the behaviour, not the styling.
class _FakeAcademic implements AcademicRepository {
  _FakeAcademic({this.mine, this.error});

  final MyAcademic? mine;
  final Object? error;

  @override
  Future<MyAcademic> me() async {
    if (error != null) throw error!;
    return mine ?? const MyAcademic();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

MyAcademic _withOneEnrollment() => MyAcademic.fromJson({
  'enrollments': [
    {
      'enrollment': {
        'id': 'e1',
        'halaqaId': 'h1',
        'status': 'ACTIVE',
        'enrolledAt': '2026-10-01T08:00:00.000Z',
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
          'id': 'h1',
          'code': 'hal-1',
          'name': 'حلقة الفجر',
          'order': 1,
          'status': 'ACTIVE',
        },
      },
      'teachers': [
        {'userId': 't1', 'role': 'TEACHER', 'displayName': 'الأستاذ عمر'},
      ],
    },
  ],
  'teaching': const [],
  'truncated': false,
});

Future<void> _pump(WidgetTester tester, _FakeAcademic academic) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        // Backend mode so the demo banner stays out of the way.
        backendModeProvider.overrideWithValue(true),
        academicRepositoryProvider.overrideWithValue(academic),
      ],
      child: const MaterialApp(home: StudentWorkspaceScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('lists the student halaqa with its placement and teachers', (
    tester,
  ) async {
    await _pump(tester, _FakeAcademic(mine: _withOneEnrollment()));

    expect(find.text('حلقة الفجر'), findsOneWidget);
    expect(find.text('قسم التجويد · برنامج الإتقان'), findsOneWidget);
    expect(find.text('المعلّمون'), findsOneWidget);
    expect(find.text('الأستاذ عمر — معلّم'), findsOneWidget);
  });

  testWidgets('shows the empty state when the student is enrolled in nothing', (
    tester,
  ) async {
    await _pump(tester, _FakeAcademic(mine: const MyAcademic()));

    expect(find.text('لست مسجَّلًا في أي حلقة'), findsOneWidget);
    expect(find.text('حلقة الفجر'), findsNothing);
  });

  testWidgets('shows an error with retry when the load fails', (tester) async {
    await _pump(
      tester,
      _FakeAcademic(
        error: const AcademicException('network.unreachable', 'offline'),
      ),
    );

    expect(
      find.text('تعذّر الاتصال بالخادم. تحقّق من الاتصال.'),
      findsOneWidget,
    );
    expect(find.widgetWithText(OutlinedButton, 'تحديث'), findsOneWidget);
  });
}

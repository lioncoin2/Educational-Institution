import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/scheduling.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_academic_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

ScheduledLesson _lesson(String id, {LessonStatus status = LessonStatus.scheduled}) {
  final at = DateTime.utc(2027, 3, 1, 6);
  return ScheduledLesson(
    id: id,
    halaqaId: 'h-1',
    title: 'الدرس $id',
    localDate: '2027-03-01',
    localTime: '09:00',
    timezone: 'Asia/Riyadh',
    scheduledAt: at,
    status: status,
    createdAt: at,
    createdBy: 'owner-1',
    updatedAt: at,
    cancelledAt: status == LessonStatus.cancelled ? at : null,
    cancelledBy: status == LessonStatus.cancelled ? 'owner-1' : null,
  );
}

class _FakeScheduling implements SchedulingRepository {
  _FakeScheduling(List<ScheduledLesson> seed) : _lessons = [...seed];

  final List<ScheduledLesson> _lessons;
  final List<String> writes = [];
  String? failWith;
  bool throwOnList = false;

  @override
  DataOrigin get origin => DataOrigin.records;

  @override
  Future<LessonPage> lessons({String? halaqaId, String? cursor}) async {
    if (throwOnList) throw const SchedulingException('operations.unavailable', 'x');
    return LessonPage(items: _lessons);
  }

  @override
  Future<ScheduledLesson> lesson(String id) async => _lessons.firstWhere(
        (l) => l.id == id,
        orElse: () => throw const SchedulingException('operations.lesson_not_found', 'no'),
      );

  @override
  Future<ScheduledLesson> schedule({
    required String halaqaId,
    String? title,
    required String date,
    required String time,
    required String timezone,
    String? clientRequestId,
  }) async {
    if (failWith != null) throw SchedulingException(failWith!, failWith!);
    writes.add('schedule');
    final created = _lesson('new');
    _lessons.add(created);
    return created;
  }

  @override
  Future<ScheduledLesson> reschedule(String id,
      {required String date, required String time, required String timezone, String? title}) async {
    if (failWith != null) throw SchedulingException(failWith!, failWith!);
    writes.add('reschedule $id');
    return _lesson(id);
  }

  @override
  Future<ScheduledLesson> cancel(String id) async {
    if (failWith != null) throw SchedulingException(failWith!, failWith!);
    writes.add('cancel $id');
    final index = _lessons.indexWhere((l) => l.id == id);
    final cancelled = _lesson(id, status: LessonStatus.cancelled);
    if (index >= 0) _lessons[index] = cancelled;
    return cancelled;
  }
}

CurrentUser _user(Set<String> permissions) => CurrentUser(
      id: 'me',
      displayName: 'المالك',
      status: AccountStatus.active,
      roles: const [],
      permissions: permissions,
    );

List<Override> _overrides(SchedulingRepository repo, CurrentUser user) => [
      schedulingRepositoryProvider.overrideWithValue(repo),
      academicRepositoryProvider.overrideWithValue(MockAcademicRepository()),
      backendModeProvider.overrideWithValue(true),
      sessionUserProvider.overrideWith((ref) async => user),
    ];

void main() {
  testWidgets('shows the add control to a scheduler and lists lessons', (tester) async {
    final repo = _FakeScheduling([_lesson('l1')]);
    await openApp(tester, Routes.schedulingList,
        overrides: _overrides(repo, _user({'operations.schedule_manage'})));
    expect(find.byKey(const Key('scheduling-add-fab')), findsOneWidget);
    expect(find.text('الدرس l1'), findsOneWidget);
  });

  testWidgets('hides the add control from a non-scheduler', (tester) async {
    final repo = _FakeScheduling([_lesson('l1')]);
    await openApp(tester, Routes.schedulingList,
        overrides: _overrides(repo, _user({'academic.read'})));
    expect(find.byKey(const Key('scheduling-add-fab')), findsNothing);
  });

  testWidgets('shows an empty state when there are no lessons', (tester) async {
    final repo = _FakeScheduling([]);
    await openApp(tester, Routes.schedulingList,
        overrides: _overrides(repo, _user({'operations.schedule_manage'})));
    expect(find.text('لا توجد دروس مجدولة'), findsOneWidget);
  });

  testWidgets('shows a retry on a load error and re-fetches', (tester) async {
    final repo = _FakeScheduling([_lesson('l1')])..throwOnList = true;
    await openApp(tester, Routes.schedulingList,
        overrides: _overrides(repo, _user({'operations.schedule_manage'})));
    expect(find.text('إعادة المحاولة'), findsOneWidget);
    repo.throwOnList = false;
    await tester.tap(find.text('إعادة المحاولة'));
    await tester.pumpAndSettle();
    expect(find.text('الدرس l1'), findsOneWidget);
  });

  testWidgets('opens the form with the submit disabled until a time is chosen', (tester) async {
    final repo = _FakeScheduling([_lesson('l1')]);
    await openApp(tester, Routes.schedulingList,
        overrides: _overrides(repo, _user({'operations.schedule_manage'})));
    await tester.tap(find.byKey(const Key('scheduling-add-fab')));
    await tester.pumpAndSettle();
    expect(find.text('جدولة درس'), findsWidgets);
    final submit = tester.widget<FilledButton>(find.byKey(const Key('lesson-form-submit')));
    expect(submit.onPressed, isNull); // no date/time/halaqa yet
  });

  testWidgets('cancels a lesson after confirmation and toasts success', (tester) async {
    final repo = _FakeScheduling([_lesson('l1')]);
    await openApp(tester, Routes.schedulingLesson('l1'),
        overrides: _overrides(repo, _user({'operations.schedule_manage'})));
    await tester.tap(find.byKey(const Key('scheduling-cancel')));
    await tester.pumpAndSettle();
    // Confirmation stands between the tap and the write.
    expect(repo.writes, isEmpty);
    await tester.tap(find.byKey(const Key('scheduling-cancel-confirm')));
    await tester.pumpAndSettle();
    expect(repo.writes, contains('cancel l1'));
    expect(find.text('تم إلغاء الدرس'), findsOneWidget);
  });

  testWidgets('renders a backend refusal as an Arabic message', (tester) async {
    final repo = _FakeScheduling([_lesson('l1')])..failWith = 'identity.permission_denied';
    await openApp(tester, Routes.schedulingLesson('l1'),
        overrides: _overrides(repo, _user({'operations.schedule_manage'})));
    await tester.tap(find.byKey(const Key('scheduling-cancel')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('scheduling-cancel-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('هذا الإجراء غير متاح لك.'), findsOneWidget);
    expect(repo.writes, isEmpty);
  });
}

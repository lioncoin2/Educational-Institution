import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_academic_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// One browser, two learners. The learner's own providers — the profile
/// header, the path, the current halaqa — are plain (kept-alive)
/// FutureProviders on always-mounted tabs, so they must follow the signed-in
/// account: after A signs out and B signs in, nothing of A's may be shown.
String? _signedIn;

class _Auth implements AuthRepository {
  @override
  Future<CurrentUser?> currentUser() async => _signedIn == null
      ? null
      : CurrentUser(
          id: _signedIn!,
          displayName: _signedIn == 'learner-a' ? 'الطالب أ' : 'الطالبة ب',
          status: AccountStatus.active,
          roles: const ['STUDENT'],
          permissions: const {'academic.study'},
        );

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

/// Learner A is enrolled in one halaqa; learner B in none. Counts every
/// `me()` — the learner's own record, answered per account. (The path
/// screen's handling of a failed read is pinned by
/// `test/learning_path/learning_path_account_switch_test.dart`.)
class _CountingAcademic extends MockAcademicRepository {
  int meCalls = 0;

  @override
  Future<MyAcademic> me() async {
    meCalls++;
    if (_signedIn == 'learner-b') return const MyAcademic();
    return _enrolledOnce();
  }
}

MyAcademic _enrolledOnce() => MyAcademic.fromJson({
  'enrollments': [
    {
      'enrollment': {
        'id': 'e-a',
        'halaqaId': 'h-a',
        'status': 'ACTIVE',
        'enrolledAt': '2026-10-01T08:00:00.000Z',
      },
      'placement': {
        'section': {
          'id': 's-a',
          'code': 'sec-a',
          'name': 'قسم التجويد',
          'order': 1,
          'status': 'ACTIVE',
          'kind': 'SPECIAL',
        },
        'program': {
          'id': 'p-a',
          'code': 'prog-a',
          'name': 'برنامج الإتقان',
          'order': 1,
          'status': 'ACTIVE',
        },
        'halaqa': {
          'id': 'h-a',
          'code': 'hal-a',
          'name': 'حلقة الفجر',
          'order': 1,
          'status': 'ACTIVE',
        },
      },
      'teachers': const [],
    },
  ],
  'teaching': const [],
  'truncated': false,
});

void main() {
  late ProviderContainer container;
  late _CountingAcademic academic;

  setUp(() {
    _signedIn = 'learner-a';
    academic = _CountingAcademic();
    container = ProviderContainer(
      overrides: [
        backendModeProvider.overrideWithValue(true),
        authRepositoryProvider.overrideWithValue(_Auth()),
        academicRepositoryProvider.overrideWithValue(academic),
      ],
    );
    addTearDown(container.dispose);
  });

  Future<void> switchTo(String? account) async {
    _signedIn = account;
    container.invalidate(sessionUserProvider);
    await container.read(sessionUserProvider.future);
    await pumpEventQueue();
  }

  test(
    'the profile header names the account signed in now, not the last one',
    () async {
      await container.read(sessionUserProvider.future);
      container.listen(studentProvider, (_, _) {});
      final ofA = await container.read(studentProvider.future);
      expect(ofA.name, 'الطالب أ');
      expect(ofA.currentProgramName, 'قسم التجويد');

      await switchTo(null);
      await switchTo('learner-b');

      final ofB = await container.read(studentProvider.future);
      expect(ofB.name, 'الطالبة ب');
      expect(ofB.currentProgramName, isNull); // B is enrolled in nothing
    },
  );

  test(
    'the path and the current halaqa are read again for the next learner',
    () async {
      await container.read(sessionUserProvider.future);
      container.listen(pathProvider, (_, _) {});
      container.listen(currentHalaqaProvider, (_, _) {});
      await container.read(pathProvider.future);
      await container.read(currentHalaqaProvider.future);
      final readsAsA = academic.meCalls;

      await switchTo(null);
      await switchTo('learner-b');
      await container.read(pathProvider.future);
      await container.read(currentHalaqaProvider.future);

      expect(academic.meCalls, greaterThan(readsAsA));
    },
  );
}

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/academic.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_academic_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

/// مساري on one browser, two learners. A rebuild after the account changes
/// keeps the last learner's path inside its loading or error state
/// (Riverpod's `previous`); the screen must never draw anything from it.
///
/// Learner A has a record and no current enrollment, so مساري says so (the
/// "no active enrollment" card is derived from A's record). Learner B's read
/// fails. Before the fix the screen read `path.hasValue`/`path.value`, which
/// stay true of A's record in B's error state — and showed A's card to B.
String? _signedIn;

const _notEnrolled = 'لا يوجد تسجيل نشط لكِ في حلقة من حلقات هذه الأقسام.';

class _Auth implements AuthRepository {
  @override
  Future<CurrentUser?> currentUser() async => _signedIn == null
      ? null
      : CurrentUser(
          id: _signedIn!,
          displayName: _signedIn!,
          status: AccountStatus.active,
          roles: const ['STUDENT'],
          permissions: const {'academic.study'},
        );

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

/// A has an (empty) record; B's record cannot be read.
class _Academic extends MockAcademicRepository {
  @override
  Future<MyAcademic> me() async {
    if (_signedIn == 'learner-b') {
      throw const AcademicException('unavailable', 'outage');
    }
    return const MyAcademic();
  }
}

void main() {
  testWidgets('a failed read of the next learner\'s path shows nothing derived '
      'from the last learner\'s', (tester) async {
    _signedIn = 'learner-a';
    final container = await openApp(
      tester,
      Routes.path,
      overrides: [
        ...backendOverrides(CommunityServer({}), signedIn: true),
        authRepositoryProvider.overrideWithValue(_Auth()),
        academicRepositoryProvider.overrideWithValue(_Academic()),
      ],
    );
    // A's own record: no current enrollment, and the screen says so.
    expect(find.text(_notEnrolled), findsOneWidget);

    _signedIn = 'learner-b';
    container.invalidate(sessionUserProvider);
    await tester.pumpAndSettle();

    // B's path failed to load: Riverpod still holds A's as `previous` …
    expect(container.read(pathProvider).hasValue, isTrue);
    expect(container.read(pathProvider).hasError, isTrue);
    // … and the screen draws nothing from it.
    expect(find.text(_notEnrolled), findsNothing);
  });
}

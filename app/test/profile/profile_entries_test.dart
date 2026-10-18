import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/features/academic_admin/academic_admin_copy.dart';
import 'package:quran_institution_app/features/admin/admin_copy.dart';
import 'package:quran_institution_app/features/student/student_copy.dart';
import 'package:quran_institution_app/features/teacher/teacher_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

/// The role entries on «حسابي»: each shown exactly to a holder of its
/// permission — the account directory (`users.read`), the student's own
/// halaqat (`academic.study`), the teacher's (`academic.teach`) and the
/// academic structure (`academic.manage`). Hiding an entry is a convenience,
/// never the rule: the server refuses each screen's calls on its own.
CurrentUser _user(Set<String> permissions) => CurrentUser(
  id: 'me',
  displayName: 'مستخدم',
  status: AccountStatus.active,
  roles: const [],
  permissions: permissions,
);

const _entries = {
  'users.read': AdminCopy.screenTitle,
  'academic.study': StudentCopy.workspaceTitle,
  'academic.teach': TeacherCopy.workspaceTitle,
  'academic.manage': AcademicAdminCopy.screenTitle,
};

/// The permissions each role holds that gate an entry (provisional matrix).
const _roles = <String, Set<String>>{
  'a student': {'academic.study'},
  'a teacher': {'academic.teach'},
  'a supervisor': {'users.read'},
  'an administrator': {'users.read', 'academic.manage'},
  'someone holding none of them': {},
};

void main() {
  for (final MapEntry(key: role, value: permissions) in _roles.entries) {
    testWidgets('$role sees exactly the entries their permissions open', (
      tester,
    ) async {
      await openApp(
        tester,
        Routes.profile,
        overrides: [
          sessionUserProvider.overrideWith((ref) async => _user(permissions)),
        ],
      );
      for (final MapEntry(key: permission, value: label) in _entries.entries) {
        expect(
          find.text(label),
          permissions.contains(permission) ? findsOneWidget : findsNothing,
          reason: '$role · $label',
        );
      }
    });
  }

  testWidgets('signed out, no role entry is shown', (tester) async {
    await openApp(
      tester,
      Routes.profile,
      overrides: [sessionUserProvider.overrideWith((ref) async => null)],
    );
    for (final label in _entries.values) {
      expect(find.text(label), findsNothing, reason: label);
    }
  });
}

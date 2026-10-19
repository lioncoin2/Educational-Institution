import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/people.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_people_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/messaging/messaging_copy.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

/// The teacher directory (Q6): a student finds an eligible teacher by name and
/// starts a direct conversation with them. The action is offered only to an
/// account that may (`messaging.start_direct_teacher`); the server returns only
/// teachers and re-authorises the start.
void main() {
  const student = CurrentUser(
    id: 'mock-student',
    displayName: 'طالب تجريبي',
    status: AccountStatus.active,
    roles: ['STUDENT'],
    permissions: {
      'messaging.read',
      'messaging.send',
      'messaging.start_direct_peer',
      'messaging.start_direct_teacher',
    },
  );

  List<Override> asStudent() => [
    messagingRepositoryProvider.overrideWithValue(MockMessagingRepository(latency: Duration.zero)),
    peopleRepositoryProvider.overrideWithValue(MockPeopleRepository(latency: Duration.zero)),
    sessionUserProvider.overrideWith((ref) async => student),
  ];

  testWidgets('a student finds a teacher in the directory and opens a DM', (tester) async {
    final container = await openApp(tester, Routes.messages, overrides: asStudent());

    expect(find.byKey(const Key('message-teacher')), findsOneWidget);
    await tester.tap(find.byKey(const Key('message-teacher')));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('message-teacher-search')), 'ال');
    await tester.pump(const Duration(milliseconds: 350)); // the search debounce
    await tester.pumpAndSettle();
    // The demo teacher directory answers "ال" with الأستاذ عبدالله only.
    expect(find.byKey(const Key('message-teacher-mock-teacher')), findsOneWidget);

    await tester.tap(find.byKey(const Key('message-teacher-mock-teacher')));
    await tester.pumpAndSettle();

    // The demo already seeds a conversation with this teacher: the start reuses
    // it (canonical) and opens it by its id.
    expect(locationIn(container), Routes.conversation('mock-direct'));
  });

  testWidgets('a viewer without the teacher-messaging capability sees no such action', (
    tester,
  ) async {
    const reader = CurrentUser(
      id: 'mock-student',
      displayName: 'طالب',
      status: AccountStatus.active,
      roles: ['STUDENT'],
      permissions: {'messaging.read', 'messaging.send'}, // no start_direct_teacher
    );
    await openApp(
      tester,
      Routes.messages,
      overrides: [sessionUserProvider.overrideWith((ref) async => reader)],
    );
    expect(find.byKey(const Key('message-teacher')), findsNothing);
  });

  testWidgets('a 503 from the directory shows a recoverable error, not an empty list, and does not navigate', (
    tester,
  ) async {
    final container = await openApp(
      tester,
      Routes.messages,
      overrides: [
        peopleRepositoryProvider.overrideWithValue(_UnavailablePeople()),
        sessionUserProvider.overrideWith((ref) async => student),
      ],
    );

    await tester.tap(find.byKey(const Key('message-teacher')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('message-teacher-search')), 'ال');
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pumpAndSettle();

    // A transient outage reads as a recoverable error, never "no teachers found".
    expect(find.text(MessagingCopy.teacherSearchError('unavailable')), findsOneWidget);
    expect(find.text(MessagingCopy.messageTeacherNoResults), findsNothing);
    // Nothing opened: the viewer stays on the conversations list.
    expect(locationIn(container), Routes.messages);
  });
}

/// A teacher directory that is briefly unavailable (the server's 503, code
/// `unavailable`) — to prove the picker distinguishes an outage from an empty
/// result and never navigates on failure.
class _UnavailablePeople implements PeopleRepository {
  @override
  Future<PeopleSearchPage> search(String query, {String? cursor}) async =>
      throw const PeopleException('unavailable', 'briefly unavailable');

  @override
  Future<PeopleSearchPage> searchTeachers(String query, {String? cursor}) async =>
      throw const PeopleException('unavailable', 'briefly unavailable');

  @override
  Future<Uri> personAvatarUrl(String userId) async =>
      throw const PeopleException('unavailable', 'briefly unavailable');
}

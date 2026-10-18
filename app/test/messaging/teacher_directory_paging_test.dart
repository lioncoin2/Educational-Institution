import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/people.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/messaging/messaging_copy.dart';
import 'package:quran_institution_app/features/messaging/state/teacher_search_provider.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import '../communities/community_test_support.dart';

/// The teacher directory answers a keyset page at a time (server default 50).
/// The picker used to show the first page only; these pin every page shape:
/// empty, one final page, and several — appended in order, never twice, and a
/// failed next page keeping what is shown.
class _PagedTeachers implements PeopleRepository {
  _PagedTeachers(this.pages, {this.failNextPage = false, this.failWith});

  /// The server's pages for any query, in order; a page's cursor is its index.
  final List<List<String>> pages;
  bool failNextPage;

  /// What a failed next page throws: a refusal, unless something else.
  final Object? failWith;

  /// When set, a next page waits for it — still in flight.
  Completer<void>? slowNextPage;
  final List<String?> cursors = [];

  @override
  Future<PeopleSearchPage> searchTeachers(
    String query, {
    String? cursor,
  }) async {
    cursors.add(cursor);
    final index = cursor == null ? 0 : int.parse(cursor);
    if (cursor != null && slowNextPage != null) await slowNextPage!.future;
    if (cursor != null && failNextPage) {
      failNextPage = false;
      throw failWith ?? const PeopleException('network.unreachable', 'offline');
    }
    return PeopleSearchPage(
      items: [
        for (final name in pages[index])
          PersonSearchResult(userId: 'id-$name', displayName: name),
      ],
      nextCursor: index + 1 < pages.length ? '${index + 1}' : null,
    );
  }

  @override
  Future<PeopleSearchPage> search(String query, {String? cursor}) =>
      throw UnimplementedError();
}

ProviderContainer _container(_PagedTeachers people) {
  final container = ProviderContainer(
    overrides: [peopleRepositoryProvider.overrideWithValue(people)],
  );
  addTearDown(container.dispose);
  return container;
}

void main() {
  const query = 'ال';

  test('a blank term asks nothing and finds nothing', () async {
    final people = _PagedTeachers([
      ['أحمد'],
    ]);
    final container = _container(people);
    container.listen(teacherSearchProvider('  '), (_, _) {});

    final state = await container.read(teacherSearchProvider('  ').future);
    expect(state.items, isEmpty);
    expect(state.hasMore, isFalse);
    expect(people.cursors, isEmpty);
  });

  test('one final page: everything shown, nothing more to ask for', () async {
    final container = _container(
      _PagedTeachers([
        ['أحمد', 'خالد'],
      ]),
    );
    container.listen(teacherSearchProvider(query), (_, _) {});

    final state = await container.read(teacherSearchProvider(query).future);
    expect(state.items.map((t) => t.displayName), ['أحمد', 'خالد']);
    expect(state.hasMore, isFalse);
  });

  test('several pages: appended in the server\'s order, a teacher never twice, '
      'until the last', () async {
    final people = _PagedTeachers([
      ['أحمد', 'خالد'],
      ['خالد', 'سعيد'], // the keyset moved under us: خالد again
      ['عمر'],
    ]);
    final container = _container(people);
    container.listen(teacherSearchProvider(query), (_, _) {});
    await container.read(teacherSearchProvider(query).future);
    final controller = container.read(teacherSearchProvider(query).notifier);

    await controller.loadMore();
    await controller.loadMore();
    final state = container.read(teacherSearchProvider(query)).requireValue;

    expect(state.items.map((t) => t.displayName), [
      'أحمد',
      'خالد',
      'سعيد',
      'عمر',
    ]);
    expect(state.hasMore, isFalse);
    expect(people.cursors, [null, '1', '2']);

    await controller.loadMore(); // nothing more: no request
    expect(people.cursors, [null, '1', '2']);
  });

  test(
    'a failed next page keeps what is shown, says so, and can be retried',
    () async {
      final people = _PagedTeachers([
        ['أحمد'],
        ['خالد'],
      ], failNextPage: true);
      final container = _container(people);
      container.listen(teacherSearchProvider(query), (_, _) {});
      await container.read(teacherSearchProvider(query).future);
      final controller = container.read(teacherSearchProvider(query).notifier);

      await controller.loadMore();
      var state = container.read(teacherSearchProvider(query)).requireValue;
      expect(state.items.map((t) => t.displayName), ['أحمد']);
      expect(state.loadMoreFailed, isTrue);
      expect(state.hasMore, isTrue);

      await controller.loadMore();
      state = container.read(teacherSearchProvider(query)).requireValue;
      expect(state.items.map((t) => t.displayName), ['أحمد', 'خالد']);
      expect(state.loadMoreFailed, isFalse);
    },
  );

  // Found by the adversarial review: only a refusal was caught, so any other
  // failure left the spinner forever with no retry.
  test('a next page failing in any way keeps what is shown, offers the retry, '
      'and does not swallow a defect', () async {
    final container = _container(
      _PagedTeachers(
        [
          ['أحمد'],
          ['خالد'],
        ],
        failNextPage: true,
        failWith: StateError('an answer that could not be read'),
      ),
    );
    container.listen(teacherSearchProvider(query), (_, _) {});
    await container.read(teacherSearchProvider(query).future);

    // A failure that is not a refusal is a defect: reported, not swallowed.
    await expectLater(
      container.read(teacherSearchProvider(query).notifier).loadMore(),
      throwsA(isA<StateError>()),
    );

    final state = container.read(teacherSearchProvider(query)).requireValue;
    expect(state.loadingMore, isFalse);
    expect(state.loadMoreFailed, isTrue);
    expect(state.items.map((t) => t.displayName), ['أحمد']);
  });

  test(
    'a next page asked for before the directory was read again is dropped',
    () async {
      final first = _PagedTeachers([
        ['أحمد'],
        ['خالد'],
      ])..slowNextPage = Completer<void>();
      final holder = NotifierProvider<_Repository, PeopleRepository>(
        () => _Repository(first),
      );
      final container = ProviderContainer(
        overrides: [
          peopleRepositoryProvider.overrideWith((ref) => ref.watch(holder)),
        ],
      );
      addTearDown(container.dispose);
      container.listen(teacherSearchProvider(query), (_, _) {});
      await container.read(teacherSearchProvider(query).future);
      final pending = container
          .read(teacherSearchProvider(query).notifier)
          .loadMore();

      container
          .read(holder.notifier)
          .replace(
            _PagedTeachers([
              ['سعيد'],
            ]),
          );
      await container.read(teacherSearchProvider(query).future);
      first.slowNextPage!.complete();
      await pending;
      await pumpEventQueue();

      final state = container.read(teacherSearchProvider(query)).requireValue;
      expect(state.items.map((t) => t.displayName), ['سعيد']);
    },
  );

  testWidgets('the picker offers the next page while there is one, and then '
      'stops', (tester) async {
    const student = CurrentUser(
      id: 'mock-student',
      displayName: 'طالب',
      status: AccountStatus.active,
      roles: ['STUDENT'],
      permissions: {'messaging.read', 'messaging.start_direct_teacher'},
    );
    await openApp(
      tester,
      Routes.messages,
      overrides: [
        messagingRepositoryProvider.overrideWithValue(
          MockMessagingRepository(latency: Duration.zero),
        ),
        peopleRepositoryProvider.overrideWithValue(
          _PagedTeachers([
            ['أحمد'],
            ['خالد'],
          ]),
        ),
        sessionUserProvider.overrideWith((ref) async => student),
      ],
    );
    await tester.tap(find.byKey(const Key('message-teacher')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('message-teacher-search')),
      query,
    );
    await tester.pump(const Duration(milliseconds: 350)); // the debounce
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('message-teacher-id-أحمد')), findsOneWidget);
    expect(find.byKey(const Key('message-teacher-id-خالد')), findsNothing);
    expect(find.text(MessagingCopy.messageTeacherMore), findsOneWidget);

    await tester.tap(find.byKey(const Key('message-teacher-more')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('message-teacher-id-خالد')), findsOneWidget);
    expect(find.text(MessagingCopy.messageTeacherMore), findsNothing);
  });
}

class _Repository extends Notifier<PeopleRepository> {
  _Repository(this.initial);

  final PeopleRepository initial;

  @override
  PeopleRepository build() => initial;

  void replace(PeopleRepository next) => state = next;
}

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/people.dart';
import '../../../providers/app_providers.dart';

/// What the message-a-teacher picker shows for one typed name prefix: the
/// teachers found so far, in the server's order, and whether there are more.
class TeacherSearchState {
  const TeacherSearchState({
    required this.items,
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  final List<PersonSearchResult> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;

  TeacherSearchState copyWith({bool? loadingMore, bool? loadMoreFailed}) =>
      TeacherSearchState(
        items: items,
        nextCursor: nextCursor,
        loadingMore: loadingMore ?? this.loadingMore,
        loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
      );
}

/// The teacher-directory results for a typed display-name prefix (Q6) — the
/// message-a-teacher picker's source, a keyset page at a time. A blank query
/// is an empty result (no request). Keyed on the query, so each distinct term
/// is its own read and a page asked for under one term can never land in
/// another's list; `autoDispose` so it is released when the picker closes.
/// The server decides who may search and returns ONLY eligible teachers
/// ([PeopleRepository.searchTeachers]); a refusal (an account without the
/// teacher-messaging capability) surfaces as a [PeopleException].
class TeacherSearchController extends AsyncNotifier<TeacherSearchState> {
  TeacherSearchController(this.query);

  final String query;

  String get _term => query.trim();

  /// Moves on with every build: the notifier outlives a rebuild, so a page
  /// asked for under the last build is dropped, never spliced onto this one.
  int _epoch = 0;

  @override
  Future<TeacherSearchState> build() async {
    _epoch += 1;
    final repository = ref.watch(peopleRepositoryProvider);
    if (_term.isEmpty) return const TeacherSearchState(items: []);
    final page = await repository.searchTeachers(_term);
    return TeacherSearchState(items: page.items, nextCursor: page.nextCursor);
  }

  /// The next page, appended — never twice at once, never while the first
  /// is on its way; a teacher already shown is not shown again. A failure
  /// keeps what is shown and offers a retry.
  Future<void> loadMore() async {
    final current = state.asData?.value;
    if (current == null ||
        state.isLoading ||
        !current.hasMore ||
        current.loadingMore) {
      return;
    }
    final epoch = _epoch;
    state = AsyncData(
      current.copyWith(loadingMore: true, loadMoreFailed: false),
    );
    try {
      final page = await ref
          .read(peopleRepositoryProvider)
          .searchTeachers(_term, cursor: current.nextCursor);
      if (!ref.mounted || epoch != _epoch) return;
      final now = state.asData?.value ?? current;
      final seen = {for (final teacher in now.items) teacher.userId};
      state = AsyncData(
        TeacherSearchState(
          items: [
            ...now.items,
            for (final teacher in page.items)
              if (!seen.contains(teacher.userId)) teacher,
          ],
          nextCursor: page.nextCursor,
        ),
      );
    } on PeopleException {
      // A refusal or an unreadable answer: keep what is shown, offer the retry.
      _failed(epoch, current);
    } catch (_) {
      // Anything else is a defect, not a state: the spinner must not stay,
      // and the error must not vanish either — it goes on to be reported.
      _failed(epoch, current);
      rethrow;
    }
  }

  void _failed(int epoch, TeacherSearchState current) {
    if (!ref.mounted || epoch != _epoch) return;
    state = AsyncData(
      (state.asData?.value ?? current).copyWith(
        loadingMore: false,
        loadMoreFailed: true,
      ),
    );
  }
}

final teacherSearchProvider = AsyncNotifierProvider.autoDispose
    .family<TeacherSearchController, TeacherSearchState, String>(
      TeacherSearchController.new,
      retry: (_, _) => null,
    );

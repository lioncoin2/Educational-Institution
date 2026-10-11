import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/people.dart';
import '../../../providers/app_providers.dart';

/// The teacher-directory results for a typed display-name prefix (Q6) — the
/// message-a-teacher picker's source. A blank query is an empty page (no
/// request). Keyed on the query so each distinct term is its own cached read;
/// `autoDispose` so it is released when the picker closes. The server decides
/// who may search and returns ONLY eligible teachers
/// ([PeopleRepository.searchTeachers]); a refusal (an account without the
/// teacher-messaging capability) surfaces as a [PeopleException].
final teacherSearchProvider = FutureProvider.autoDispose.family<PeopleSearchPage, String>((
  ref,
  query,
) {
  final trimmed = query.trim();
  if (trimmed.isEmpty) return Future.value(const PeopleSearchPage(items: []));
  return ref.watch(peopleRepositoryProvider).searchTeachers(trimmed);
}, retry: (_, _) => null);

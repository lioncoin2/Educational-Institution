import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/people.dart';
import '../../../providers/app_providers.dart';

/// The people-search results for a typed display-name prefix — the add-member
/// picker's source. A blank query is an empty page (no request). Keyed on the
/// query so each distinct term is its own cached read; `autoDispose` so it is
/// released when the picker closes. The server decides who may search and whom
/// they may find — this only asks ([PeopleRepository.search]); a refusal
/// (a caller without `people.read`) surfaces as a [PeopleException].
final peopleSearchProvider = FutureProvider.autoDispose.family<PeopleSearchPage, String>((
  ref,
  query,
) {
  final trimmed = query.trim();
  if (trimmed.isEmpty) return Future.value(const PeopleSearchPage(items: []));
  return ref.watch(peopleRepositoryProvider).search(trimmed);
}, retry: (_, _) => null);

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/people.dart';
import '../../../providers/app_providers.dart';

/// The arguments a member-candidate search is keyed on: which community, and
/// the typed display-name prefix.
typedef MemberCandidatesArgs = ({String communityId, String query});

/// The add-member picker's candidate results for one community and a typed
/// prefix — the community-scoped search (Sprint 24, Design X). A blank query is
/// an empty page (no request). Keyed on `(communityId, query)` so each term is
/// its own cached read; `autoDispose` so it is released when the picker closes.
/// The server decides, per community, whether the caller may search (on
/// `community.members.invite` in that community) and whom they may find — this
/// only asks ([CommunityRepository.memberCandidates]); a refusal (the caller
/// lacks invite authority here) surfaces as a [PeopleException]. It never
/// reaches the institution-wide directory.
final communityMemberCandidatesProvider = FutureProvider.autoDispose
    .family<PeopleSearchPage, MemberCandidatesArgs>((ref, args) {
      final trimmed = args.query.trim();
      if (trimmed.isEmpty) return Future.value(const PeopleSearchPage(items: []));
      return ref
          .watch(communityRepositoryProvider)
          .memberCandidates(args.communityId, trimmed);
    }, retry: (_, _) => null);

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/communities.dart';
import 'community_controller.dart';
import 'community_list_controller.dart';

/// After the server confirmed (or refused) a change to [communityId] made on
/// one of its screens, the community and its row in the list are read
/// again — each through its own one-at-a-time read, and only where it is
/// open: a view not open reads anew when it opens. [confirmed] — what the
/// change answered, when it answered the community as the viewer now stands
/// in it (a hand-over) — is shown in both at once. Completes once both
/// reads have landed.
///
/// Through the [container], not the writing controller's Ref: the screen
/// that sent the change may be gone by the time its answer comes, and what
/// the change touched is reconciled all the same.
Future<void> reconcileCommunity(
  ProviderContainer container,
  String communityId, {
  Community? confirmed,
}) {
  final community = communityProvider(communityId);
  return Future.wait([
    if (container.exists(community))
      container.read(community.notifier).reconcile(confirmed: confirmed),
    if (container.exists(communityListProvider))
      container
          .read(communityListProvider.notifier)
          .reconcileCommunity(communityId, confirmed: confirmed),
  ]);
}

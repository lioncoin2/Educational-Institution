import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'community_controller.dart';
import 'community_list_controller.dart';

/// After the server confirmed (or refused) a change to [communityId] made on
/// one of its screens, the community and its row in the list are read
/// again — each through its own one-at-a-time read, and only where it is
/// open: a view not open reads anew when it opens. Completes once both
/// reads have landed.
Future<void> reconcileCommunity(Ref ref, String communityId) {
  final community = communityProvider(communityId);
  return Future.wait([
    if (ref.exists(community)) ref.read(community.notifier).reconcile(),
    if (ref.exists(communityListProvider))
      ref.read(communityListProvider.notifier).reconcileCommunity(communityId),
  ]);
}

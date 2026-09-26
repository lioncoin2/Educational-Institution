import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../messaging/state/conversation_list_controller.dart';

/// The server confirmed the viewer's own leave of [communityId] ([left]), or
/// their join: their chats follow. The Messages list, wherever it is open,
/// takes a left community's chat out at once, then reads its first page
/// again — as the community's frames would have it, which may never come
/// (the demo has none; a connection may be down). A list not open reads
/// anew when it opens.
void reconcileMembership(
  ProviderContainer container,
  String communityId, {
  required bool left,
}) {
  if (!container.exists(conversationListProvider)) return;
  final chats = container.read(conversationListProvider.notifier);
  unawaited(
    left
        ? chats.communityLeft(communityId)
        : chats.communityJoined(communityId),
  );
}

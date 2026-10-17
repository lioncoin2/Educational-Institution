import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../providers/app_providers.dart';

/// The signed-in viewer's muted conversations (Q6 / ADR 0036): the set of
/// conversation ids whose PUSH they have silenced. Loaded once from
/// `GET /notifications/mutes` and kept for the session; [setMuted] flips one
/// conversation through `PUT`/`DELETE /notifications/mutes/:id`.
///
/// Muting silences PUSH only — in-app and realtime delivery are unchanged
/// (that is the server's policy; this never decides it). All network access is
/// the repository's; the update is optimistic and reverts if the server
/// refuses, so the toggle never shows a state the server did not accept.
class ConversationMutesController extends AsyncNotifier<Set<String>> {
  @override
  Future<Set<String>> build() =>
      ref.watch(notificationsRepositoryProvider).mutedConversations();

  /// Mutes [conversationId] when [muted], otherwise unmutes it. Optimistic:
  /// the set updates immediately and rolls back on failure (then rethrows so
  /// the caller can report it).
  Future<void> setMuted(String conversationId, bool muted) async {
    final repo = ref.read(notificationsRepositoryProvider);
    final previous = state.value ?? const <String>{};
    final next = {...previous};
    if (muted) {
      next.add(conversationId);
    } else {
      next.remove(conversationId);
    }
    state = AsyncData(next);
    try {
      if (muted) {
        await repo.muteConversation(conversationId);
      } else {
        await repo.unmuteConversation(conversationId);
      }
    } catch (_) {
      state = AsyncData(previous);
      rethrow;
    }
  }
}

final conversationMutesProvider =
    AsyncNotifierProvider<ConversationMutesController, Set<String>>(
  ConversationMutesController.new,
);

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/notifications.dart';
import '../../../providers/app_providers.dart';

/// The signed-in viewer's muted conversations (Q6 / ADR 0036): the set of
/// conversation ids whose PUSH they have silenced. Loaded once from
/// `GET /notifications/mutes` and kept for the session — the signed-in
/// account's session: another account is another set, read again the moment
/// the account changes, so nothing of the previous one's survives a sign-out
/// on a shared device. [setMuted] flips one
/// conversation through `PUT`/`DELETE /notifications/mutes/:id`.
///
/// Muting silences PUSH only — in-app and realtime delivery are unchanged
/// (that is the server's policy; this never decides it). All network access is
/// the repository's; the update is optimistic and reverts if the server
/// refuses, so the toggle never shows a state the server did not accept.
class ConversationMutesController extends AsyncNotifier<Set<String>> {
  /// Moves on with every build: the notifier outlives a rebuild, so a toggle
  /// answered after the account changed must not write into the next set.
  int _epoch = 0;

  @override
  Future<Set<String>> build() {
    // A different account is a different set: rebuilt when the account changes.
    ref.watch(sessionUserProvider.select((session) => session.value?.id));
    _epoch += 1;
    return ref.watch(notificationsRepositoryProvider).mutedConversations();
  }

  /// Mutes [conversationId] when [muted], otherwise unmutes it. Optimistic:
  /// the set updates immediately and rolls back on failure (then rethrows so
  /// the caller can report it).
  ///
  /// Refused until this account's set is loaded: a rebuild keeps the last
  /// account's set as Riverpod's `previous`, and a toggle computed from it
  /// would write that account's mutes into this one's.
  Future<void> setMuted(String conversationId, bool muted) async {
    final repo = ref.read(notificationsRepositoryProvider);
    final previous = state.asData?.value;
    if (previous == null) {
      throw const NotificationsException(
        'notifications.mutes_not_loaded',
        'The muted conversations are not loaded yet.',
      );
    }
    final epoch = _epoch;
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
      if (ref.mounted && epoch == _epoch) state = AsyncData(previous);
      rethrow;
    }
  }
}

final conversationMutesProvider =
    AsyncNotifierProvider<ConversationMutesController, Set<String>>(
  ConversationMutesController.new,
  // A refusal (signed out, offline) settles at once; the screen retries.
  retry: (_, _) => null,
);

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/messaging.dart';
import '../../../data/realtime/realtime_client.dart';
import '../../../data/realtime/realtime_frames.dart';
import '../../../providers/app_providers.dart';

class ConversationListState {
  const ConversationListState({
    required this.items,
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  /// Most recently active first, as the server orders them.
  final List<Conversation> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;

  ConversationListState copyWith({
    List<Conversation>? items,
    bool? loadingMore,
    bool? loadMoreFailed,
  }) => ConversationListState(
    items: items ?? this.items,
    nextCursor: nextCursor,
    loadingMore: loadingMore ?? this.loadingMore,
    loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
  );
}

/// The signed-in person's conversations, a page at a time — kept current
/// by the live connection while it is up:
///
///   conversation.created a conversation to show: the list is fetched again
///   message.sent         the conversation's preview, activity, unread count
///                        and place in the list
///   message.deleted      the preview, if it was the deleted message, becomes
///                        a neutral "deleted" marker (ADR 0029 §6)
///   message.read         the badge clears (read on another device)
///   participant.added    a conversation to show: the list is fetched again
///   participant.removed  the conversation leaves the list
///
/// A community's chat follows the viewer's membership, which messaging does
/// not announce — the community's frames do:
///
///   community.member.added    (the viewer) the list is fetched again: the
///                             chat may be theirs now
///   community.member.removed  (the viewer) that community's chat leaves the
///                             list at once, then the list is fetched again —
///                             the server's word stands over the frame's
///
/// — and so does the server's answer to the viewer's own leave or join
/// ([communityLeft], [communityJoined]): a frame may never come (the demo
/// has none; a connection may be down).
///
/// Whenever the connection comes (back) up, the first page is fetched again
/// over HTTP: whatever happened while it was down is in there.
class ConversationListController extends AsyncNotifier<ConversationListState> {
  String? _viewerId;
  Future<void>? _resyncing;

  /// Moves on whenever what is shown stops being the pages [loadMore]
  /// extends — the first page replaced, or a conversation taken out — so a
  /// next page asked for before is dropped rather than spliced on.
  int _generation = 0;

  /// Moves on with every build — the account changing, a refresh. The
  /// notifier (and its `ref`) outlives a rebuild, so `ref.mounted` cannot tell
  /// a page asked for under the last build from one asked for under this one;
  /// a result is applied only if the build that asked for it is still current.
  int _epoch = 0;

  /// What is shown, only while it is settled data of the current build. A
  /// rebuild keeps the previous build's value inside its loading or error
  /// state (Riverpod's `previous`); that is the last account's inbox, and no
  /// update may be computed from it.
  ConversationListState? get _shown => state.asData?.value;

  @override
  Future<ConversationListState> build() async {
    // Kept for the app's life, so it must follow the account: a different
    // account is a different inbox — rebuilt the moment the account changes,
    // so a sign-out on a shared device leaves nothing of the last one's here.
    ref.watch(sessionUserProvider.select((session) => session.value?.id));
    _epoch += 1;
    _generation += 1;
    _viewerId = null;
    _resyncing = null;
    final repository = ref.watch(messagingRepositoryProvider);
    final realtime = ref.watch(realtimeConnectionProvider);
    final events = realtime.events.listen(_onEvent);
    final statuses = realtime.statuses.listen(_onStatus);
    ref.onDispose(() {
      unawaited(events.cancel());
      unawaited(statuses.cancel());
    });

    final epoch = _epoch;
    final (page, viewer) = await (
      repository.conversations(),
      repository.viewerId(),
    ).wait;
    if (epoch == _epoch) _viewerId = viewer;
    return ConversationListState(
      items: page.items,
      nextCursor: page.nextCursor,
    );
  }

  /// The next page, appended — never while the first is on its way. A
  /// failure keeps what is shown and offers retry; a page cut from a list no
  /// longer shown is dropped.
  Future<void> loadMore() async {
    final current = _shown;
    if (current == null ||
        state.isLoading ||
        !current.hasMore ||
        current.loadingMore) {
      return;
    }
    final repository = ref.read(messagingRepositoryProvider);
    final generation = _generation;
    final epoch = _epoch;
    state = AsyncData(
      current.copyWith(loadingMore: true, loadMoreFailed: false),
    );
    try {
      final page = await repository.conversations(cursor: current.nextCursor);
      if (!ref.mounted || epoch != _epoch) return;
      final now = _shown ?? current;
      if (generation != _generation) {
        state = AsyncData(now.copyWith(loadingMore: false));
        return;
      }
      final seen = {for (final c in now.items) c.id};
      state = AsyncData(
        ConversationListState(
          items: [
            ...now.items,
            ...page.items.where((c) => !seen.contains(c.id)),
          ],
          nextCursor: page.nextCursor,
        ),
      );
    } on MessagingException {
      if (!ref.mounted || epoch != _epoch) return;
      state = AsyncData(
        (_shown ?? current).copyWith(
          loadingMore: false,
          loadMoreFailed: generation == _generation,
        ),
      );
    }
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  /// Clears a conversation's badge locally once it has been read, without
  /// refetching the list.
  void markedRead(String conversationId, int sequence) {
    final current = _shown;
    if (current == null) return;
    state = AsyncData(
      current.copyWith(
        items: [
          for (final c in current.items)
            c.id == conversationId ? c.withReadUpTo(sequence) : c,
        ],
      ),
    );
  }

  /// A message is stored — by this device's send, or reported by the
  /// server. Moves its conversation to the top with the new preview; a
  /// message already counted changes nothing.
  void messageStored(Message message, {String? senderName}) {
    final current = _shown;
    if (current == null) return;
    final index = current.items.indexWhere(
      (c) => c.id == message.conversationId,
    );
    if (index < 0) {
      // A conversation this list has not loaded: ask the server.
      unawaited(_resync());
      return;
    }
    final before = current.items[index];
    final after = before.withMessage(
      message,
      senderName: senderName,
      fromViewer: message.senderId == _viewerId,
    );
    if (identical(before, after)) return;
    state = AsyncData(
      current.copyWith(
        items: _byActivity([
          for (final c in current.items)
            if (c.id != after.id) c,
          after,
        ]),
      ),
    );
  }

  /// A message was deleted (ADR 0029 §6). If it was the conversation's latest
  /// — the one the preview shows — the preview becomes a neutral "deleted"
  /// marker; an older message's deletion is not visible in the list. A
  /// conversation this list has not loaded, or whose preview is a different
  /// message, is left unchanged (a re-read reconciles).
  /// A message was edited by its author (ADR 0045): if it is the one the
  /// preview shows, the preview reads its new text. Nothing else moves.
  void messageEdited(Message message) {
    final current = _shown;
    if (current == null) return;
    final index = current.items.indexWhere(
      (c) => c.id == message.conversationId,
    );
    if (index < 0) return;
    final before = current.items[index];
    final after = before.withEditedPreview(message);
    if (identical(before, after)) return;
    state = AsyncData(
      current.copyWith(
        items: [for (final c in current.items) c.id == after.id ? after : c],
      ),
    );
  }

  void messageDeleted(String conversationId, int sequence) {
    final current = _shown;
    if (current == null) return;
    final index = current.items.indexWhere((c) => c.id == conversationId);
    if (index < 0) return;
    final last = current.items[index].lastMessage;
    if (last == null || last.sequence != sequence || last.deleted) return;
    state = AsyncData(
      current.copyWith(
        items: [
          for (final c in current.items)
            c.id == conversationId ? c.withDeletedPreview() : c,
        ],
      ),
    );
  }

  void _onEvent(RealtimeEvent event) {
    switch (event) {
      case ConversationCreatedEvent():
        final known =
            _shown?.items.any((c) => c.id == event.conversationId) ?? false;
        if (!known) unawaited(_resync());
      case MessageSentEvent():
        messageStored(event.message, senderName: event.senderName);
      case MessageEditedEvent():
        messageEdited(event.message);
      case MessageDeletedEvent():
        messageDeleted(event.conversationId, event.sequence);
      case MessageReadEvent() when event.userId == _viewerId:
        markedRead(event.conversationId, event.lastReadSequence);
      case ParticipantAddedEvent() when event.userId == _viewerId:
        unawaited(_resync());
      case CommunityMemberAddedEvent() when event.userId == _viewerId:
        unawaited(communityJoined(event.communityId));
      case CommunityMemberRemovedEvent() when event.userId == _viewerId:
        unawaited(communityLeft(event.communityId));
      case ParticipantRemovedEvent() when event.userId == _viewerId:
        final current = _shown;
        if (current == null) return;
        _generation += 1;
        state = AsyncData(
          current.copyWith(
            items: [
              for (final c in current.items)
                if (c.id != event.conversationId) c,
            ],
          ),
        );
      default:
        return;
    }
  }

  /// The viewer is a member of [communityId] now: its chat may be theirs —
  /// the list is fetched again. Completes once that read has landed (or
  /// failed, keeping what is shown).
  Future<void> communityJoined(String communityId) => _resyncAfterRunning();

  /// The viewer is no longer a member of [communityId]: its chat leaves the
  /// list at once, then the list is fetched again — the server's word stands
  /// over what was taken out.
  Future<void> communityLeft(String communityId) {
    final current = _shown;
    if (current != null) {
      _generation += 1;
      state = AsyncData(
        current.copyWith(
          items: [
            for (final c in current.items)
              if (c.communityId != communityId) c,
          ],
        ),
      );
    }
    return _resyncAfterRunning();
  }

  void _onStatus(RealtimeStatus status) {
    if (status.isLive) unawaited(_resync());
  }

  /// The first page again, quietly — no spinner over what is shown. Runs
  /// once at a time; a failure keeps what is shown.
  Future<void> _resync() {
    final running = _resyncing;
    if (running != null) return running;
    late final Future<void> next;
    // Clears only its own slot: a rebuild may have started a newer resync.
    next = _fetchFirstPage().whenComplete(() {
      if (identical(_resyncing, next)) _resyncing = null;
    });
    return _resyncing = next;
  }

  /// A first-page read that starts after the one in flight, if any — the
  /// list's own first read included: that one may have been answered before
  /// the change now being caught up with. A first read that fails leaves a
  /// retry, which reads anew.
  Future<void> _resyncAfterRunning() async {
    if (state.isLoading) {
      try {
        await future;
      } on Object {
        return;
      }
    }
    await _resyncing;
    if (ref.mounted) await _resync();
  }

  Future<void> _fetchFirstPage() async {
    if (_shown == null) return; // Still loading: build fetches anyway.
    final epoch = _epoch;
    try {
      final page = await ref.read(messagingRepositoryProvider).conversations();
      // Asked for under a build that is no longer current — the last
      // account's, say: its answer is the last account's inbox. Dropped.
      if (!ref.mounted || epoch != _epoch) return;
      _generation += 1;
      state = AsyncData(
        ConversationListState(
          items: page.items,
          nextCursor: page.nextCursor,
          // A next page on its way stays on its way — to be dropped.
          loadingMore: _shown?.loadingMore ?? false,
        ),
      );
    } on MessagingException {
      // The next event or reconnect tries again.
    }
  }

  /// Most recently active first; ties by id, as the server breaks them.
  static List<Conversation> _byActivity(List<Conversation> items) =>
      items..sort((a, b) {
        final byTime = b.activityAt.compareTo(a.activityAt);
        return byTime != 0 ? byTime : b.id.compareTo(a.id);
      });
}

final conversationListProvider =
    AsyncNotifierProvider<ConversationListController, ConversationListState>(
      ConversationListController.new,
      // Failures surface at once with a retry button; no silent backoff.
      retry: (_, _) => null,
    );

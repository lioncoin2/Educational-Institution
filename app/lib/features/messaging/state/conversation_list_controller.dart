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
/// Whenever the connection comes (back) up, the first page is fetched again
/// over HTTP: whatever happened while it was down is in there.
class ConversationListController extends AsyncNotifier<ConversationListState> {
  String? _viewerId;
  Future<void>? _resyncing;

  /// Moves on whenever what is shown stops being the pages [loadMore]
  /// extends — the first page replaced, or a conversation taken out — so a
  /// next page asked for before is dropped rather than spliced on.
  int _generation = 0;

  @override
  Future<ConversationListState> build() async {
    final repository = ref.watch(messagingRepositoryProvider);
    final realtime = ref.watch(realtimeConnectionProvider);
    final events = realtime.events.listen(_onEvent);
    final statuses = realtime.statuses.listen(_onStatus);
    ref.onDispose(() {
      unawaited(events.cancel());
      unawaited(statuses.cancel());
    });

    final (page, viewer) = await (
      repository.conversations(),
      repository.viewerId(),
    ).wait;
    _viewerId = viewer;
    return ConversationListState(
      items: page.items,
      nextCursor: page.nextCursor,
    );
  }

  /// The next page, appended — never while the first is on its way. A
  /// failure keeps what is shown and offers retry; a page cut from a list no
  /// longer shown is dropped.
  Future<void> loadMore() async {
    final current = state.value;
    if (current == null ||
        state.isLoading ||
        !current.hasMore ||
        current.loadingMore) {
      return;
    }
    final repository = ref.read(messagingRepositoryProvider);
    final generation = _generation;
    state = AsyncData(
      current.copyWith(loadingMore: true, loadMoreFailed: false),
    );
    try {
      final page = await repository.conversations(cursor: current.nextCursor);
      if (!ref.mounted) return;
      final now = state.value ?? current;
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
      if (!ref.mounted) return;
      state = AsyncData(
        (state.value ?? current).copyWith(
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
    final current = state.value;
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
    final current = state.value;
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

  void _onEvent(RealtimeEvent event) {
    switch (event) {
      case ConversationCreatedEvent():
        final known =
            state.value?.items.any((c) => c.id == event.conversationId) ??
            false;
        if (!known) unawaited(_resync());
      case MessageSentEvent():
        messageStored(event.message, senderName: event.senderName);
      case MessageReadEvent() when event.userId == _viewerId:
        markedRead(event.conversationId, event.lastReadSequence);
      case ParticipantAddedEvent() when event.userId == _viewerId:
        unawaited(_resync());
      case CommunityMemberAddedEvent() when event.userId == _viewerId:
        unawaited(_resyncAfterRunning());
      case CommunityMemberRemovedEvent() when event.userId == _viewerId:
        final current = state.value;
        if (current == null) return;
        _generation += 1;
        state = AsyncData(
          current.copyWith(
            items: [
              for (final c in current.items)
                if (c.communityId != event.communityId) c,
            ],
          ),
        );
        unawaited(_resyncAfterRunning());
      case ParticipantRemovedEvent() when event.userId == _viewerId:
        final current = state.value;
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

  void _onStatus(RealtimeStatus status) {
    if (status.isLive) unawaited(_resync());
  }

  /// The first page again, quietly — no spinner over what is shown. Runs
  /// once at a time; a failure keeps what is shown.
  Future<void> _resync() {
    return _resyncing ??= _fetchFirstPage().whenComplete(
      () => _resyncing = null,
    );
  }

  /// A first-page read that starts after the one in flight, if any: that
  /// one may have been answered before the change now being caught up with.
  Future<void> _resyncAfterRunning() async {
    await _resyncing;
    if (ref.mounted) await _resync();
  }

  Future<void> _fetchFirstPage() async {
    if (state.value == null) return; // Still loading: build fetches anyway.
    try {
      final page = await ref.read(messagingRepositoryProvider).conversations();
      if (!ref.mounted) return;
      _generation += 1;
      state = AsyncData(
        ConversationListState(
          items: page.items,
          nextCursor: page.nextCursor,
          // A next page on its way stays on its way — to be dropped.
          loadingMore: state.value?.loadingMore ?? false,
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

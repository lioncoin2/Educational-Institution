import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/messaging.dart';
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

/// The signed-in person's conversations, a page at a time.
class ConversationListController extends AsyncNotifier<ConversationListState> {
  @override
  Future<ConversationListState> build() async {
    final page = await ref.watch(messagingRepositoryProvider).conversations();
    return ConversationListState(
      items: page.items,
      nextCursor: page.nextCursor,
    );
  }

  /// The next page, appended. A failure keeps what is shown and offers retry.
  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    final repository = ref.read(messagingRepositoryProvider);
    state = AsyncData(
      current.copyWith(loadingMore: true, loadMoreFailed: false),
    );
    try {
      final page = await repository.conversations(cursor: current.nextCursor);
      if (!ref.mounted) return;
      final seen = {for (final c in current.items) c.id};
      state = AsyncData(
        ConversationListState(
          items: [
            ...current.items,
            ...page.items.where((c) => !seen.contains(c.id)),
          ],
          nextCursor: page.nextCursor,
        ),
      );
    } on MessagingException {
      if (!ref.mounted) return;
      state = AsyncData(
        current.copyWith(loadingMore: false, loadMoreFailed: true),
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
}

final conversationListProvider =
    AsyncNotifierProvider<ConversationListController, ConversationListState>(
      ConversationListController.new,
      // Failures surface at once with a retry button; no silent backoff.
      retry: (_, _) => null,
    );

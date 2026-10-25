import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/client_ids.dart';
import '../../../data/models/live_chat.dart';
import '../../../data/realtime/realtime_client.dart';
import '../../../data/realtime/realtime_frames.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';

/// A live session's own chat as the viewer holds it (ADR 0047): oldest first,
/// each message once, and where the chat stands for the viewer.
class LiveChatState {
  const LiveChatState({
    required this.messages,
    required this.olderCursor,
    required this.locked,
    required this.lockVersion,
    required this.canPost,
    required this.canModerate,
  });

  factory LiveChatState.fromPage(LiveChatPage page) => LiveChatState(
    messages: page.items.reversed.toList(growable: false),
    olderCursor: page.nextCursor,
    locked: page.locked,
    lockVersion: page.lockVersion,
    canPost: page.canPost,
    canModerate: page.canModerate,
  );

  /// Oldest first — the order a chat reads in.
  final List<LiveChatMessage> messages;
  final String? olderCursor;
  final bool locked;
  final int lockVersion;
  final bool canPost;
  final bool canModerate;

  /// What the composer shows: open, or closed by a moderator.
  bool get closedToMe => locked && !canModerate;

  LiveChatState copyWith({
    List<LiveChatMessage>? messages,
    String? olderCursor,
    bool clearCursor = false,
    bool? locked,
    int? lockVersion,
    bool? canPost,
    bool? canModerate,
  }) => LiveChatState(
    messages: messages ?? this.messages,
    olderCursor: clearCursor ? null : olderCursor ?? this.olderCursor,
    locked: locked ?? this.locked,
    lockVersion: lockVersion ?? this.lockVersion,
    canPost: canPost ?? this.canPost,
    canModerate: canModerate ?? this.canModerate,
  );

  /// [incoming] merged in by id, ordered by the server's position.
  LiveChatState withMessages(Iterable<LiveChatMessage> incoming) {
    final byId = {for (final m in messages) m.id: m};
    for (final m in incoming) {
      byId[m.id] = m;
    }
    final merged = byId.values.toList()
      ..sort((a, b) => a.position.compareTo(b.position));
    return copyWith(messages: merged);
  }
}

/// Follows a live session's own chat (ADR 0047) — never the community's
/// conversation. The HTTP page is the authority; a `live.chat.message` frame
/// carries the message itself for this session's participants and is merged
/// by id (a duplicate changes nothing); a `live.chat.changed` frame newer than
/// the held lock version re-reads the page, since who may post is the
/// server's answer. A reconnect re-reads too: anything may have been missed.
/// Posting is never decided here: a refusal (`live.chat_locked`,
/// `live.session_not_live`) is the server's and propagates to the panel.
class LiveChatController extends AsyncNotifier<LiveChatState> {
  LiveChatController(this.sessionId);

  final String sessionId;
  Future<void>? _refreshing;

  @override
  Future<LiveChatState> build() async {
    final repository = ref.watch(liveChatRepositoryProvider);
    final realtime = ref.watch(realtimeConnectionProvider);
    final events = realtime.events.listen(_onEvent);
    final statuses = realtime.statuses.listen(_onStatus);
    ref.onDispose(() {
      unawaited(events.cancel());
      unawaited(statuses.cancel());
    });
    return LiveChatState.fromPage(await repository.page(sessionId));
  }

  LiveChatRepository get _repository => ref.read(liveChatRepositoryProvider);

  /// Posts [body]; on success the server's message joins the chat at once.
  /// A refusal throws [LiveException] for the panel to say in words.
  Future<void> send(String body) async {
    final message = await _repository.post(
      sessionId,
      clientMessageId: newClientId(),
      body: body,
    );
    if (!ref.mounted) return;
    final current = state.value;
    if (current != null) state = AsyncData(current.withMessages([message]));
  }

  /// A moderator closes or re-opens the chat; the page is re-read after.
  Future<void> setLocked(bool locked) async {
    await _repository.setLocked(sessionId, locked: locked);
    if (!ref.mounted) return;
    await _refresh();
  }

  /// Older messages, prepended in order.
  Future<void> loadOlder() async {
    final current = state.value;
    final cursor = current?.olderCursor;
    if (current == null || cursor == null) return;
    final page = await _repository.page(sessionId, before: cursor);
    if (!ref.mounted) return;
    final now = state.value ?? current;
    state = AsyncData(
      now
          .withMessages(page.items)
          .copyWith(
            olderCursor: page.nextCursor,
            clearCursor: page.nextCursor == null,
          ),
    );
  }

  void _onEvent(RealtimeEvent event) {
    if (event is! LiveEvent || event.sessionId != sessionId) return;
    final current = state.value;
    switch (event) {
      case LiveChatMessageEvent(:final message):
        if (current != null) state = AsyncData(current.withMessages([message]));
      case LiveChatChangedEvent(:final lockVersion):
        if (current == null || lockVersion > current.lockVersion) {
          unawaited(_refresh());
        }
      case LiveSessionEndedEvent():
        unawaited(_refresh());
      default:
        return;
    }
  }

  void _onStatus(RealtimeStatus status) {
    if (status.isLive && state.hasValue) unawaited(_refresh());
  }

  /// One re-read at a time; the latest page replaces the lock and rights and
  /// merges its messages with those already held.
  Future<void> _refresh() {
    final running = _refreshing;
    if (running != null) return running;
    return _refreshing = () async {
      try {
        final page = await _repository.page(sessionId);
        if (!ref.mounted) return;
        final held = state.value;
        final fresh = LiveChatState.fromPage(page);
        state = AsyncData(
          held == null
              ? fresh
              : held
                    .withMessages(page.items)
                    .copyWith(
                      locked: fresh.locked,
                      lockVersion: fresh.lockVersion,
                      canPost: fresh.canPost,
                      canModerate: fresh.canModerate,
                    ),
        );
      } on Object {
        // A failed re-read keeps what is held; the next hint or reconnect asks again.
      }
    }().whenComplete(() => _refreshing = null);
  }
}

final liveChatProvider = AsyncNotifierProvider.autoDispose
    .family<LiveChatController, LiveChatState, String>(
      LiveChatController.new,
      retry: (_, _) => null,
    );

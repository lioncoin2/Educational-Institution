import 'dart:async';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/client_ids.dart';
import '../../../data/models/messaging.dart';
import '../../../data/realtime/realtime_client.dart';
import '../../../data/realtime/realtime_frames.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';
import 'conversation_list_controller.dart';

enum DeliveryStatus { sending, failed }

/// A message the person sent that the server has not confirmed yet.
///
/// It keeps its [clientMessageId] for life: a retry resends the same id, so
/// the server stores the message once even if the first attempt did arrive.
class PendingMessage {
  const PendingMessage({
    required this.clientMessageId,
    required this.type,
    required this.createdAt,
    this.body,
    this.file,
    this.status = DeliveryStatus.sending,
    this.errorCode,
  });

  final String clientMessageId;
  final MessageType type;
  final DateTime createdAt;
  final String? body;
  final OutgoingFile? file;
  final DeliveryStatus status;
  final String? errorCode;

  PendingMessage withStatus(DeliveryStatus status, {String? errorCode}) =>
      PendingMessage(
        clientMessageId: clientMessageId,
        type: type,
        createdAt: createdAt,
        body: body,
        file: file,
        status: status,
        errorCode: errorCode,
      );
}

class ConversationState {
  const ConversationState({
    required this.conversation,
    required this.viewerId,
    required this.messages,
    required this.lastReadSequence,
    required this.syncedThrough,
    this.pending = const [],
    this.hasOlder = false,
    this.loadingOlder = false,
    this.olderFailed = false,
    this.senderNames = const {},
    this.removed = false,
  });

  final Conversation conversation;
  final String viewerId;

  /// Confirmed messages, ascending by sequence, no duplicates.
  final List<Message> messages;
  final List<PendingMessage> pending;
  final bool hasOlder;
  final bool loadingOlder;
  final bool olderFailed;
  final int lastReadSequence;
  final Map<String, String> senderNames;

  /// Every message up to this sequence is held — the server's pages are
  /// dense, so nothing below it is missing. A message beyond it that is
  /// not its immediate successor means one was missed on the way: the gap
  /// is filled over HTTP, never assumed away.
  final int syncedThrough;

  /// The viewer is no longer a member: nothing more arrives, and nothing
  /// can be sent.
  final bool removed;

  int get newestSequence => messages.isEmpty ? 0 : messages.last.sequence;

  /// A message is held beyond an unfilled gap.
  bool get hasGap => newestSequence > syncedThrough;

  bool isMine(Message message) => message.senderId == viewerId;

  ConversationState copyWith({
    Conversation? conversation,
    List<Message>? messages,
    List<PendingMessage>? pending,
    bool? hasOlder,
    bool? loadingOlder,
    bool? olderFailed,
    int? lastReadSequence,
    Map<String, String>? senderNames,
    int? syncedThrough,
    bool? removed,
  }) => ConversationState(
    conversation: conversation ?? this.conversation,
    viewerId: viewerId,
    messages: messages ?? this.messages,
    pending: pending ?? this.pending,
    hasOlder: hasOlder ?? this.hasOlder,
    loadingOlder: loadingOlder ?? this.loadingOlder,
    olderFailed: olderFailed ?? this.olderFailed,
    lastReadSequence: lastReadSequence ?? this.lastReadSequence,
    senderNames: senderNames ?? this.senderNames,
    syncedThrough: syncedThrough ?? this.syncedThrough,
    removed: removed ?? this.removed,
  );
}

/// One open conversation: its timeline, what is being sent, what is read.
///
/// Order is the server's: confirmed messages sort by sequence, never by a
/// device clock or by the order they arrived in. Messages come from three
/// places — pages, send responses and the live connection — and all go
/// through one merge, so the same message arriving twice is held once, and
/// a pending message becomes its confirmed self exactly once, whichever
/// confirmation lands first.
class ConversationController extends AsyncNotifier<ConversationState> {
  ConversationController(this.conversationId);

  final String conversationId;

  static const int pageSize = 30;

  /// Catch-up stops after this many pages; the rest is a scroll away.
  static const int maxCatchUpPages = 5;

  Future<void>? _catchingUp;
  bool _catchUpAgain = false;
  Future<void>? _refreshingConversation;
  bool _refreshConversationAgain = false;

  @override
  Future<ConversationState> build() async {
    final repository = ref.watch(messagingRepositoryProvider);
    final realtime = ref.watch(realtimeConnectionProvider);
    final events = realtime.events.listen(_onEvent);
    final statuses = realtime.statuses.listen(_onStatus);
    ref.onDispose(() {
      unawaited(events.cancel());
      unawaited(statuses.cancel());
    });
    // Once the timeline is on screen, make sure nothing slipped past
    // between loading it and the live connection.
    listenSelf((previous, next) {
      if (previous?.value == null && next.value != null) unawaited(_sync());
    });

    final (conversation, viewer, page) = await (
      repository.conversation(conversationId),
      repository.viewerId(),
      repository.messages(conversationId, limit: pageSize),
    ).wait;
    return ConversationState(
      conversation: conversation,
      viewerId: viewer,
      messages: page.items,
      hasOlder: page.hasOlder,
      lastReadSequence: page.lastReadSequence,
      senderNames: page.senderNames,
      // The latest page is complete up to its newest message.
      syncedThrough: page.items.isEmpty ? 0 : page.items.last.sequence,
    );
  }

  MessagingRepository get _repository => ref.read(messagingRepositoryProvider);

  Future<void> loadOlder() async {
    final current = state.value;
    if (current == null || !current.hasOlder || current.loadingOlder) return;
    final repository = _repository;
    state = AsyncData(current.copyWith(loadingOlder: true, olderFailed: false));
    try {
      final page = await repository.messages(
        conversationId,
        before: current.messages.isEmpty
            ? null
            : current.messages.first.sequence,
        limit: pageSize,
      );
      if (!ref.mounted) return;
      final now = state.value ?? current;
      state = AsyncData(
        now.copyWith(
          messages: _merged(now.messages, page.items),
          hasOlder: page.hasOlder,
          loadingOlder: false,
          senderNames: {...now.senderNames, ...page.senderNames},
        ),
      );
    } on MessagingException {
      if (!ref.mounted) return;
      state = AsyncData(
        (state.value ?? current).copyWith(
          loadingOlder: false,
          olderFailed: true,
        ),
      );
    }
  }

  /// Fetches what arrived after the last complete point — the refresh
  /// action, and whatever the live connection could not deliver.
  Future<void> refreshNewer() => _catchUp();

  Future<void> sendText(String text) async {
    final body = text.trim();
    if (body.isEmpty) return;
    await _enqueue(
      PendingMessage(
        clientMessageId: newClientId(),
        type: MessageType.text,
        body: body,
        createdAt: DateTime.now(),
      ),
    );
  }

  /// A picked file or a finished recording; the kind decides the message type.
  Future<void> sendFile(OutgoingFile file, {String? caption}) async {
    await _enqueue(
      PendingMessage(
        clientMessageId: newClientId(),
        type: switch (file.kind) {
          AttachmentKind.voice => MessageType.voice,
          AttachmentKind.image => MessageType.image,
          _ => MessageType.file,
        },
        body: caption,
        file: file,
        createdAt: DateTime.now(),
      ),
    );
  }

  /// Resends a failed message with its ORIGINAL clientMessageId.
  Future<void> retry(String clientMessageId) async {
    final current = state.value;
    if (current == null) return;
    final pending = current.pending
        .where((p) => p.clientMessageId == clientMessageId)
        .firstOrNull;
    if (pending == null || pending.status != DeliveryStatus.failed) return;
    _replacePending(pending.withStatus(DeliveryStatus.sending));
    await _deliver(pending);
  }

  void discard(String clientMessageId) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(
      current.copyWith(
        pending: [
          for (final p in current.pending)
            if (p.clientMessageId != clientMessageId) p,
        ],
      ),
    );
  }

  /// Moves the read watermark to the newest message the timeline holds
  /// without a gap below it — never past a message the person was not shown.
  Future<void> markLatestRead() async {
    final current = state.value;
    if (current == null || current.removed) return;
    final newest = current.syncedThrough;
    if (newest <= current.lastReadSequence) return;
    final repository = _repository;
    final list = ref.read(conversationListProvider.notifier);
    try {
      final watermark = await repository.markRead(conversationId, newest);
      if (!ref.mounted) return;
      final now = state.value ?? current;
      state = AsyncData(
        now.copyWith(lastReadSequence: max(now.lastReadSequence, watermark)),
      );
      list.markedRead(conversationId, watermark);
    } on MessagingException {
      // Read state is a courtesy; the next open marks it again.
    }
  }

  // ── The live connection ─────────────────────────────────────────────────

  void _onEvent(RealtimeEvent event) {
    if (event is CommunityEvent) {
      _onCommunityEvent(event);
      return;
    }
    if (event is! ConversationEvent || event.conversationId != conversationId) {
      return;
    }
    final current = state.value;
    // Loading: the page, then _sync, cover it. Removed: nothing more of it.
    if (current == null || current.removed) return;
    switch (event) {
      case MessageSentEvent():
        final filling = _absorb(
          [event.message],
          names: {
            if (event.senderName != null)
              event.message.senderId: event.senderName!,
          },
        );
        if (filling != null) unawaited(filling);
      case MessageReadEvent() when event.userId == current.viewerId:
        // Read on another device. Only ever forward: an older mark arriving
        // late must not undo a newer one.
        if (event.lastReadSequence > current.lastReadSequence) {
          state = AsyncData(
            current.copyWith(lastReadSequence: event.lastReadSequence),
          );
        }
      case ParticipantRemovedEvent() when event.userId == current.viewerId:
        _markRemoved();
      default:
        return;
    }
  }

  /// A community chat follows its community — and a community frame is a
  /// hint to ask again, never an answer. The viewer's removal is confirmed by
  /// the server refusing the subscription (never by the frame alone); a
  /// lock, an unlock or changed access shows in the conversation's `canPost`,
  /// read again.
  void _onCommunityEvent(CommunityEvent event) {
    final current = state.value;
    if (current == null || current.removed) return;
    if (event.communityId != current.conversation.communityId) return;
    switch (event) {
      case CommunityMemberRemovedEvent() when event.userId == current.viewerId:
        unawaited(_sync());
      case CommunityLifecycleEvent() || CommunityAccessChangedEvent():
        unawaited(_refreshConversation());
      default:
        return;
    }
  }

  void _onStatus(RealtimeStatus status) {
    if (status.isLive) unawaited(_sync());
  }

  /// The conversation itself again (title, member count, whether the viewer
  /// may post). One at a time; asked for meanwhile, once more after. "Not
  /// found" means it is no longer the viewer's; any other failure keeps what
  /// is shown.
  Future<void> _refreshConversation() {
    final running = _refreshingConversation;
    if (running != null) {
      _refreshConversationAgain = true;
      return running;
    }
    return _refreshingConversation = _runRefreshConversation().whenComplete(
      () => _refreshingConversation = null,
    );
  }

  Future<void> _runRefreshConversation() async {
    do {
      _refreshConversationAgain = false;
      final Conversation fresh;
      try {
        fresh = await _repository.conversation(conversationId);
      } on MessagingException catch (error) {
        if (!ref.mounted) return;
        if (error.code == 'messaging.conversation_not_found') _markRemoved();
        continue;
      }
      if (!ref.mounted) return;
      final now = state.value;
      if (now == null || now.removed) return;
      state = AsyncData(now.copyWith(conversation: fresh));
    } while (_refreshConversationAgain && ref.mounted);
  }

  /// Confirms this conversation over the live connection and catches up
  /// over HTTP if the server is ahead of what is held.
  Future<void> _sync() async {
    final realtime = ref.read(realtimeConnectionProvider);
    if (!realtime.status.isLive || state.value == null) return;
    final result = await realtime.subscribe(conversationId);
    if (!ref.mounted) return;
    final now = state.value;
    if (now == null) return;
    switch (result) {
      case Subscribed(:final lastSequence, :final lastReadSequence):
        if (lastReadSequence > now.lastReadSequence) {
          state = AsyncData(now.copyWith(lastReadSequence: lastReadSequence));
        }
        if (lastSequence > now.syncedThrough) await _catchUp();
      case SubscriptionRefused(:final code) when code.meansNoAccess:
        _markRemoved();
      case SubscriptionRefused():
      case SubscriptionUnavailable():
        return; // HTTP still works; the next reconnect tries again.
    }
  }

  void _markRemoved() {
    final current = state.value;
    if (current == null || current.removed) return;
    state = AsyncData(current.copyWith(removed: true, pending: const []));
  }

  // ── One way in for every confirmed message ──────────────────────────────

  /// Merges confirmed messages, retires the pending ones they confirm, and
  /// fills any gap they reveal — returning that catch-up, if one started.
  Future<void>? _absorb(
    List<Message> incoming, {
    Map<String, String> names = const {},
  }) {
    final now = state.value;
    if (now == null || incoming.isEmpty) return null;
    final merged = _merged(now.messages, incoming);
    final confirmed = {
      for (final m in incoming)
        if (m.senderId == now.viewerId && m.clientMessageId != null)
          m.clientMessageId!,
    };
    final ownNewest = incoming
        .where(now.isMine)
        .fold(now.lastReadSequence, (newest, m) => max(newest, m.sequence));
    final next = now.copyWith(
      messages: merged,
      pending: [
        for (final p in now.pending)
          if (!confirmed.contains(p.clientMessageId)) p,
      ],
      senderNames: {...now.senderNames, ...names},
      syncedThrough: _advance(now.syncedThrough, merged),
      // Sending means having read up to here — the server says so too.
      lastReadSequence: ownNewest,
    );
    state = AsyncData(next);
    return next.hasGap ? _catchUp() : null;
  }

  /// Pages forward from the complete point until the server has nothing
  /// newer. One at a time; a gap found meanwhile runs it once more.
  Future<void> _catchUp() {
    final running = _catchingUp;
    if (running != null) {
      _catchUpAgain = true;
      return running;
    }
    return _catchingUp = _runCatchUp().whenComplete(() => _catchingUp = null);
  }

  Future<void> _runCatchUp() async {
    do {
      _catchUpAgain = false;
      for (var page = 0; page < maxCatchUpPages; page++) {
        final now = state.value;
        if (now == null || now.removed) return;
        final MessagePage next;
        try {
          next = await _repository.messages(
            conversationId,
            after: now.syncedThrough,
            limit: pageSize,
          );
        } on MessagingException {
          return;
        }
        if (!ref.mounted) return;
        final current = state.value;
        if (current == null) return;
        final merged = _merged(current.messages, next.items);
        // A page is dense from its cursor: everything up to its last item
        // is now held.
        final pageEnd = next.items.isEmpty
            ? current.syncedThrough
            : max(current.syncedThrough, next.items.last.sequence);
        final confirmed = {
          for (final m in next.items)
            if (m.senderId == current.viewerId && m.clientMessageId != null)
              m.clientMessageId!,
        };
        state = AsyncData(
          current.copyWith(
            messages: merged,
            pending: [
              for (final p in current.pending)
                if (!confirmed.contains(p.clientMessageId)) p,
            ],
            senderNames: {...current.senderNames, ...next.senderNames},
            syncedThrough: _advance(pageEnd, merged),
          ),
        );
        if (!next.hasNewer || next.items.isEmpty) break;
      }
    } while (_catchUpAgain && ref.mounted && (state.value?.hasGap ?? false));
  }

  // ── Sending ─────────────────────────────────────────────────────────────

  Future<void> _enqueue(PendingMessage message) async {
    final current = state.value;
    if (current == null || current.removed) return;
    state = AsyncData(current.copyWith(pending: [...current.pending, message]));
    await _deliver(message);
  }

  Future<void> _deliver(PendingMessage message) async {
    final repository = _repository;
    try {
      final file = message.file;
      final stored = await switch (message.type) {
        MessageType.voice => repository.sendVoice(
          conversationId,
          clientMessageId: message.clientMessageId,
          recording: file!,
        ),
        MessageType.image => repository.sendImage(
          conversationId,
          clientMessageId: message.clientMessageId,
          image: file!,
          caption: message.body,
        ),
        MessageType.file => repository.sendFile(
          conversationId,
          clientMessageId: message.clientMessageId,
          file: file!,
          caption: message.body,
        ),
        _ => repository.sendText(
          conversationId,
          clientMessageId: message.clientMessageId,
          body: message.body ?? '',
        ),
      };
      if (!ref.mounted) return;
      // The same path a live copy of this message takes: whichever arrives
      // first confirms it, the other changes nothing. Others' messages that
      // landed below it are fetched before the send counts as done.
      ref.read(conversationListProvider.notifier).messageStored(stored);
      await _absorb([stored]);
    } on MessagingException catch (error) {
      if (!ref.mounted) return;
      _replacePending(
        message.withStatus(DeliveryStatus.failed, errorCode: error.code),
      );
    }
  }

  void _replacePending(PendingMessage replacement) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(
      current.copyWith(
        pending: [
          for (final p in current.pending)
            p.clientMessageId == replacement.clientMessageId ? replacement : p,
        ],
      ),
    );
  }

  /// Union by id, sorted by the server's sequence.
  static List<Message> _merged(List<Message> existing, List<Message> incoming) {
    final byId = {for (final m in existing) m.id: m};
    for (final m in incoming) {
      byId[m.id] = m;
    }
    return byId.values.toList()
      ..sort((a, b) => a.sequence.compareTo(b.sequence));
  }

  /// The complete point, moved forward over every message that directly
  /// follows it.
  static int _advance(int syncedThrough, List<Message> messages) {
    final held = {for (final m in messages) m.sequence};
    var through = syncedThrough;
    while (held.contains(through + 1)) {
      through += 1;
    }
    return through;
  }
}

final conversationProvider = AsyncNotifierProvider.autoDispose
    .family<ConversationController, ConversationState, String>(
      ConversationController.new,
      retry: (_, _) => null,
    );

/// A short-lived link to one attachment, fetched once per display rather
/// than on every rebuild; released when nothing shows it any more.
final attachmentUrlProvider = FutureProvider.autoDispose
    .family<
      Uri,
      ({String conversationId, String messageId, String fileAssetId})
    >(
      (ref, key) => ref
          .watch(messagingRepositoryProvider)
          .attachmentUrl(key.conversationId, key.messageId, key.fileAssetId),
      retry: (_, _) => null,
    );

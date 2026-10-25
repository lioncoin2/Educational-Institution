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
    this.replyToMessageId,
    this.status = DeliveryStatus.sending,
    this.errorCode,
  });

  final String clientMessageId;
  final MessageType type;
  final DateTime createdAt;
  final String? body;
  final OutgoingFile? file;

  /// The message this one answers (text replies only) — kept on the pending
  /// message so a retry resends the reply, not a bare copy.
  final String? replyToMessageId;
  final DeliveryStatus status;
  final String? errorCode;

  PendingMessage withStatus(DeliveryStatus status, {String? errorCode}) =>
      PendingMessage(
        clientMessageId: clientMessageId,
        type: type,
        createdAt: createdAt,
        body: body,
        file: file,
        replyToMessageId: replyToMessageId,
        status: status,
        errorCode: errorCode,
      );
}

/// A reply being composed: the message it will answer, with the sender and a
/// one-line preview resolved by the screen (never invented). Held in the
/// conversation's state so the composer banner and the send share one source.
class ReplyDraft {
  const ReplyDraft({
    required this.targetId,
    required this.preview,
    this.senderName,
  });

  final String targetId;
  final String? senderName;
  final String preview;
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
    this.senderAvatarAssets = const {},
    this.removed = false,
    this.replyDraft,
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

  /// Sender id → the Files asset id of their picture (or absent/null for none).
  /// A sender with an entry has a picture to resolve; one without shows
  /// initials without a round-trip.
  final Map<String, String?> senderAvatarAssets;

  /// Every message up to this sequence is held — the server's pages are
  /// dense, so nothing below it is missing. A message beyond it that is
  /// not its immediate successor means one was missed on the way: the gap
  /// is filled over HTTP, never assumed away.
  final int syncedThrough;

  /// The viewer is no longer a member: nothing more arrives, and nothing
  /// can be sent.
  final bool removed;

  /// The reply being composed, or null when not replying. Cleared on send or
  /// cancel; never carried across conversations (each has its own state).
  final ReplyDraft? replyDraft;

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
    Map<String, String?>? senderAvatarAssets,
    int? syncedThrough,
    bool? removed,
    ReplyDraft? replyDraft,
    bool clearReplyDraft = false,
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
    senderAvatarAssets: senderAvatarAssets ?? this.senderAvatarAssets,
    syncedThrough: syncedThrough ?? this.syncedThrough,
    removed: removed ?? this.removed,
    replyDraft: clearReplyDraft ? null : (replyDraft ?? this.replyDraft),
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


  /// Communities locked, unlocked or with changed access while the
  /// conversation was loading: its read may have been answered before, so
  /// a chat of one of them is read again once loaded.
  final Set<String> _communitiesChangedWhileLoading = {};

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
      final loaded = next.value;
      if (previous?.value != null || loaded == null) return;
      unawaited(_sync());
      final communityId = loaded.conversation.communityId;
      if (_communitiesChangedWhileLoading.contains(communityId)) {
        unawaited(_refreshConversation());
      }
      _communitiesChangedWhileLoading.clear();
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
      senderAvatarAssets: page.senderAvatarAssets,
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
          senderAvatarAssets: {
            ...now.senderAvatarAssets,
            ...page.senderAvatarAssets,
          },
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
  /// action, and whatever the live connection could not deliver. A closed
  /// chat asks the server instead whether the viewer is admitted again.
  Future<void> refreshNewer() =>
      (state.value?.removed ?? false) ? _sync() : _catchUp();

  /// Begins a reply to [draft]'s target. Ignored when the viewer cannot post
  /// or has left — the server is still the authority on the send itself.
  void startReply(ReplyDraft draft) {
    final current = state.value;
    if (current == null || current.removed || !current.conversation.canPost) {
      return;
    }
    state = AsyncData(current.copyWith(replyDraft: draft));
  }

  /// Drops the reply being composed, leaving any pending/failed reply intact
  /// (its relationship lives on its own pending message).
  void cancelReply() {
    final current = state.value;
    if (current == null || current.replyDraft == null) return;
    state = AsyncData(current.copyWith(clearReplyDraft: true));
  }

  Future<void> sendText(String text) async {
    final body = text.trim();
    if (body.isEmpty) return;
    // The reply, if one is being composed, rides on this message and is baked
    // into the pending record so a retry resends it. The draft clears on
    // enqueue (the relationship is now the pending message's).
    final replyTo = state.value?.replyDraft?.targetId;
    await _enqueue(
      PendingMessage(
        clientMessageId: newClientId(),
        type: MessageType.text,
        body: body,
        replyToMessageId: replyTo,
        createdAt: DateTime.now(),
      ),
    );
  }

  /// A picked file or a finished recording; the kind decides the message type.
  /// A reply being composed rides on it too (images, documents and recordings
  /// all answer a message exactly as text does), baked into the pending record
  /// so an upload failure and its retry keep the relationship.
  Future<void> sendFile(OutgoingFile file, {String? caption}) async {
    final replyTo = state.value?.replyDraft?.targetId;
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
        replyToMessageId: replyTo,
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

  // ── Moderation (community chat only, ADR 0029) ──────────────────────────
  // The server is the authority; it re-asks Communities for
  // `community.messages.moderate` on every call. The screen offers these only
  // when the community's `me` already grants it, but a refusal still surfaces
  // as a [MessagingException] for the screen to explain.

  /// Deletes a message as a moderator. On success the held message becomes a
  /// tombstone at once — the server having confirmed it — so the timeline
  /// reflects the delete without a re-read; the exact instant re-reads on
  /// reopen. The original stays reviewable for 7 days ([reviewMessage]). A
  /// refusal propagates; nothing local changes then.
  Future<void> moderateDelete(String messageId) async {
    await _repository.deleteMessage(conversationId, messageId);
    if (!ref.mounted) return;
    _markDeleted(messageId, DateTime.now().toUtc());
  }

  // ── The author's own message (ADR 0045) ─────────────────────────────────
  // Only the author edits, in any conversation they may post in; the author
  // deletes their own in any conversation they are in. The server decides
  // both on every call; a refusal propagates as a [MessagingException].

  /// Edits the viewer's own [messageId] to [body] (a text, or a caption). On
  /// success the held copy is replaced by the server's answer at once.
  Future<void> editMessage(String messageId, String body) async {
    final edited = await _repository.editMessage(
      conversationId,
      messageId,
      body: body,
    );
    if (!ref.mounted) return;
    _replaceMessage(edited);
    ref.read(conversationListProvider.notifier).messageEdited(edited);
  }

  /// Deletes the viewer's own [messageId] — the same tombstone a moderator's
  /// delete leaves, the server having confirmed it.
  Future<void> deleteOwnMessage(String messageId) async {
    await _repository.deleteMessage(conversationId, messageId);
    if (!ref.mounted) return;
    _markDeleted(messageId, DateTime.now().toUtc());
  }

  /// Replaces the held copy of [message] with it — an edit, from this device or
  /// relayed — unless it is not held, the held one is a tombstone (a delete
  /// always wins), or the held one is already as new or newer.
  void _replaceMessage(Message message) {
    final current = state.value;
    if (current == null) return;
    final held = current.messages.where((m) => m.id == message.id).firstOrNull;
    if (held == null || held.isDeleted || message.isDeleted) return;
    final heldAt = held.editedAt;
    final newAt = message.editedAt;
    if (heldAt != null && (newAt == null || !newAt.isAfter(heldAt))) return;
    state = AsyncData(
      current.copyWith(
        messages: [
          for (final m in current.messages) m.id == message.id ? message : m,
        ],
      ),
    );
  }

  /// Pins [messageId] (ADR 0043). The server authorizes and validates; on
  /// success the conversation is re-read so the banner reflects the server's
  /// pin. A refusal throws [MessagingException] for the caller to report.
  Future<void> pinMessage(String messageId) async {
    await _repository.pinMessage(conversationId, messageId);
    if (!ref.mounted) return;
    await _refreshConversation();
  }

  /// Clears the pin (ADR 0043). Never deletes the message; re-reads on success.
  Future<void> unpinMessage() async {
    await _repository.unpinMessage(conversationId);
    if (!ref.mounted) return;
    await _refreshConversation();
  }

  /// Replaces the held message [messageId] with a tombstone if it is held and
  /// not already deleted — the local effect of a confirmed delete, whether this
  /// viewer did it ([moderateDelete]) or another moderator did and the server
  /// relayed a `message.deleted` hint (ADR 0029 §6). A message not held (below
  /// the synced gap, or never loaded) or already a tombstone is a no-op; a
  /// re-read on reopen shows the authoritative state. Never fabricates content:
  /// [Message.asTombstone] blanks body and attachments, exactly as a server
  /// read of a deleted message would.
  void _markDeleted(String messageId, DateTime at) {
    final current = state.value;
    if (current == null) return;
    if (!current.messages.any((m) => m.id == messageId && !m.isDeleted)) return;
    state = AsyncData(
      current.copyWith(
        messages: [
          for (final message in current.messages)
            if (message.id == messageId && !message.isDeleted)
              message.asTombstone(at)
            else
              message,
        ],
      ),
    );
  }

  /// Reveals a deleted message's original for review — the one disclosure of
  /// its content and who deleted it (ADR 0029). It changes no state; the screen
  /// shows the result. A refusal (the window passed, or no such deleted
  /// message) propagates as a [MessagingException].
  Future<ReviewedMessage> reviewMessage(String messageId) =>
      _repository.reviewDeletedMessage(conversationId, messageId);

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
      case MessageEditedEvent():
        // Its author edited it — on another device, or another member (ADR
        // 0045). The frame carries the message as it now reads.
        _replaceMessage(event.message);
      case MessageDeletedEvent():
        // A moderator deleted a message — this viewer on another device, or
        // another moderator (ADR 0029 §6). The hint has no body and no deleter;
        // mark the held message a tombstone. Not held → no-op (a re-read shows
        // it). The original is reachable only through the audited review.
        _markDeleted(event.messageId, event.occurredAt);
      case MessagePinnedEvent():
        // Another moderator pinned, unpinned or replaced the pin (ADR 0043).
        // Accept it only when its version is STRICTLY NEWER than the state's —
        // the single ordering rule, so a duplicate, an older, or an equal-time
        // frame never regresses newer state. The banner's preview is resolved
        // from the loaded timeline, so an id for a message not held shows a
        // truthful fallback — never fabricated content.
        if (event.pinVersion > current.conversation.pinVersion) {
          state = AsyncData(
            current.copyWith(
              conversation: current.conversation.withPin(
                event.pinnedMessageId,
                event.pinVersion,
              ),
            ),
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
  /// the server refusing the subscription (never by the frame alone), and
  /// their return by the server admitting them again; a lock, an unlock or
  /// changed access shows in the conversation's `canPost`, read again —
  /// once loaded, for one that came while it loaded.
  void _onCommunityEvent(CommunityEvent event) {
    final current = state.value;
    if (current == null) {
      if (event is CommunityLifecycleEvent ||
          event is CommunityAccessChangedEvent) {
        _communitiesChangedWhileLoading.add(event.communityId);
      }
      return;
    }
    if (event.communityId != current.conversation.communityId) return;
    switch (event) {
      case CommunityMemberAddedEvent() when event.userId == current.viewerId:
        unawaited(_sync());
      case _ when current.removed:
        return;
      case CommunityMemberRemovedEvent() when event.userId == current.viewerId:
        unawaited(_sync());
      case CommunityLifecycleEvent() || CommunityAccessChangedEvent():
        unawaited(_refreshConversation());
      default:
        return;
    }
  }

  void _onStatus(RealtimeStatus status) {
    if (status.isLive) {
      unawaited(_sync());
      // Re-read the conversation too, so a pin change (ADR 0043) — or a lock,
      // mode or membership change — that happened while disconnected is
      // recovered authoritatively, not only new messages.
      unawaited(_refreshConversation());
    }
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
      // The refresh is an authoritative SNAPSHOT, not licence to overwrite a
      // newer pin already applied from an event: take all of `fresh` EXCEPT the
      // pin when the held pin version is newer (ADR 0043 §realtime). A snapshot
      // this stale for the pin keeps the newer pinned id and version.
      final reconciled = fresh.pinVersion >= now.conversation.pinVersion
          ? fresh
          : fresh.withPin(
              now.conversation.pinnedMessageId,
              now.conversation.pinVersion,
            );
      state = AsyncData(now.copyWith(conversation: reconciled));
    } while (_refreshConversationAgain && ref.mounted);
  }

  /// Confirms this conversation over the live connection and catches up
  /// over HTTP if the server is ahead of what is held. A closed chat the
  /// server admits the viewer to again is loaded anew: a new stint, whose
  /// history and read mark are the server's to say — nothing of the old
  /// one is carried into it.
  Future<void> _sync() async {
    final realtime = ref.read(realtimeConnectionProvider);
    if (!realtime.status.isLive || state.value == null) return;
    final result = await realtime.subscribe(conversationId);
    if (!ref.mounted) return;
    final now = state.value;
    if (now == null) return;
    switch (result) {
      case Subscribed() when now.removed:
        ref.invalidateSelf();
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
            senderAvatarAssets: {
              ...current.senderAvatarAssets,
              ...next.senderAvatarAssets,
            },
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
    // Sending anything clears the reply banner: a text reply has baked the
    // relationship into its pending message; an attachment carries none (the
    // media routes take no reply), so no stale banner is left hanging.
    state = AsyncData(
      current.copyWith(
        pending: [...current.pending, message],
        clearReplyDraft: true,
      ),
    );
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
          replyToMessageId: message.replyToMessageId,
        ),
        MessageType.image => repository.sendImage(
          conversationId,
          clientMessageId: message.clientMessageId,
          image: file!,
          caption: message.body,
          replyToMessageId: message.replyToMessageId,
        ),
        MessageType.file => repository.sendFile(
          conversationId,
          clientMessageId: message.clientMessageId,
          file: file!,
          caption: message.body,
          replyToMessageId: message.replyToMessageId,
        ),
        _ => repository.sendText(
          conversationId,
          clientMessageId: message.clientMessageId,
          body: message.body ?? '',
          replyToMessageId: message.replyToMessageId,
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

/// A short-lived link to a sender's picture, resolved at view time like their
/// name. Keyed by a representative message of that sender (see the timeline),
/// so one fetch serves all their bubbles. A sender with no picture resolves to
/// null, and the bubble shows initials.
final senderAvatarUrlProvider = FutureProvider.autoDispose
    .family<Uri?, ({String conversationId, String messageId})>((ref, key) async {
      try {
        return await ref
            .watch(messagingRepositoryProvider)
            .senderAvatarUrl(key.conversationId, key.messageId);
      } on MessagingException {
        return null; // no picture (or demo) → initials
      }
    }, retry: (_, _) => null);

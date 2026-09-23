import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/api/client_ids.dart';
import '../../../data/models/messaging.dart';
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
    this.pending = const [],
    this.hasOlder = false,
    this.loadingOlder = false,
    this.olderFailed = false,
    this.senderNames = const {},
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

  int get newestSequence => messages.isEmpty ? 0 : messages.last.sequence;

  bool isMine(Message message) => message.senderId == viewerId;

  ConversationState copyWith({
    List<Message>? messages,
    List<PendingMessage>? pending,
    bool? hasOlder,
    bool? loadingOlder,
    bool? olderFailed,
    int? lastReadSequence,
    Map<String, String>? senderNames,
  }) => ConversationState(
    conversation: conversation,
    viewerId: viewerId,
    messages: messages ?? this.messages,
    pending: pending ?? this.pending,
    hasOlder: hasOlder ?? this.hasOlder,
    loadingOlder: loadingOlder ?? this.loadingOlder,
    olderFailed: olderFailed ?? this.olderFailed,
    lastReadSequence: lastReadSequence ?? this.lastReadSequence,
    senderNames: senderNames ?? this.senderNames,
  );
}

/// One open conversation: its timeline, what is being sent, what is read.
///
/// Order is the server's: confirmed messages sort by sequence, never by a
/// device clock. Pending messages sit after them until confirmed.
class ConversationController extends AsyncNotifier<ConversationState> {
  ConversationController(this.conversationId);

  final String conversationId;

  static const int pageSize = 30;

  /// Catch-up after a gap stops after this many pages; the rest is a scroll away.
  static const int maxCatchUpPages = 5;

  @override
  Future<ConversationState> build() async {
    final repository = ref.watch(messagingRepositoryProvider);
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

  /// Fetches what arrived since the newest message shown. No realtime push
  /// in V1: this runs on the refresh action and after each send.
  Future<void> refreshNewer() async {
    final current = state.value;
    if (current == null) return;
    await _catchUp(current.newestSequence);
  }

  /// Pages forward from [after] — which may be below the newest message
  /// shown, when a send landed beyond a gap others' messages left.
  Future<void> _catchUp(int after) async {
    final repository = _repository;
    var cursor = after;
    for (var page = 0; page < maxCatchUpPages; page++) {
      final MessagePage next;
      try {
        next = await repository.messages(
          conversationId,
          after: cursor,
          limit: pageSize,
        );
      } on MessagingException {
        return;
      }
      if (!ref.mounted) return;
      final now = state.value;
      if (now == null) return;
      state = AsyncData(
        now.copyWith(
          messages: _merged(now.messages, next.items),
          senderNames: {...now.senderNames, ...next.senderNames},
        ),
      );
      if (!next.hasNewer || next.items.isEmpty) return;
      cursor = next.items.last.sequence;
    }
  }

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

  /// Moves the read watermark to the newest message shown.
  Future<void> markLatestRead() async {
    final current = state.value;
    if (current == null) return;
    final newest = current.newestSequence;
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

  Future<void> _enqueue(PendingMessage message) async {
    final current = state.value;
    if (current == null) return;
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
      final now = state.value;
      if (now == null) return;
      final before = now.newestSequence;
      final gap = stored.sequence > before + 1;
      state = AsyncData(
        now.copyWith(
          messages: _merged(now.messages, [stored]),
          pending: [
            for (final p in now.pending)
              if (p.clientMessageId != message.clientMessageId) p,
          ],
          // Sending means having read up to here — the server says so too.
          lastReadSequence: max(now.lastReadSequence, stored.sequence),
        ),
      );
      ref.invalidate(conversationListProvider);
      // Others wrote meanwhile: fill the gap below our message.
      if (gap) await _catchUp(before);
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

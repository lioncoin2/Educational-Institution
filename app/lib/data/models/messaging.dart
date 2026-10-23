import 'dart:typed_data';

import 'communities.dart' show CommunityKind;
import 'data_origin.dart';

/// Messaging, as the backend describes it (backend/src/modules/messaging/api).
///
/// Every enum has an `unknown` member so a value a newer server adds —
/// a VIDEO message, a MODERATOR role — degrades gracefully on an older app
/// instead of crashing it.

enum ConversationType {
  direct,
  group,
  channel,
  unknown;

  static ConversationType fromWire(String value) => switch (value) {
    'DIRECT' => direct,
    'GROUP' => group,
    'CHANNEL' => channel,
    _ => unknown,
  };
}

enum MessageType {
  text,
  voice,
  image,
  file,
  unknown;

  static MessageType fromWire(String value) => switch (value) {
    'TEXT' => text,
    'VOICE' => voice,
    'IMAGE' => image,
    'FILE' => file,
    _ => unknown,
  };
}

enum ParticipantRole {
  owner,
  publisher,
  member,
  unknown;

  static ParticipantRole fromWire(String value) => switch (value) {
    'OWNER' => owner,
    'PUBLISHER' => publisher,
    'MEMBER' => member,
    _ => unknown,
  };
}

/// What a stored file is — the server's `FileKind`.
enum AttachmentKind {
  image('IMAGE'),
  voice('VOICE'),
  audio('AUDIO'),
  document('DOCUMENT'),
  unknown('UNKNOWN');

  const AttachmentKind(this.wire);

  final String wire;

  static AttachmentKind fromWire(String? value) => switch (value) {
    'IMAGE' => image,
    'VOICE' => voice,
    'AUDIO' => audio,
    'DOCUMENT' => document,
    _ => unknown,
  };
}

/// A file on a message. [available] is false once the server no longer has
/// it; the other fields are then null.
class Attachment {
  const Attachment({
    required this.fileAssetId,
    required this.available,
    this.kind = AttachmentKind.unknown,
    this.contentType,
    this.byteSize,
    this.displayName,
    this.durationMs,
    this.width,
    this.height,
  });

  factory Attachment.fromJson(Map<String, Object?> json) => Attachment(
    fileAssetId: json['fileAssetId']! as String,
    available: json['available']! as bool,
    kind: AttachmentKind.fromWire(json['kind'] as String?),
    contentType: json['contentType'] as String?,
    byteSize: json['byteSize'] as int?,
    displayName: json['displayName'] as String?,
    durationMs: json['durationMs'] as int?,
    width: json['width'] as int?,
    height: json['height'] as int?,
  );

  final String fileAssetId;
  final bool available;
  final AttachmentKind kind;
  final String? contentType;
  final int? byteSize;
  final String? displayName;
  final int? durationMs;
  final int? width;
  final int? height;
}

class Message {
  const Message({
    required this.id,
    required this.conversationId,
    required this.sequence,
    required this.senderId,
    required this.type,
    required this.createdAt,
    this.body,
    this.replyToMessageId,
    this.clientMessageId,
    this.editedAt,
    this.deletedAt,
    this.attachments = const [],
  });

  factory Message.fromJson(Map<String, Object?> json) => Message(
    id: json['id']! as String,
    conversationId: json['conversationId']! as String,
    sequence: json['sequence']! as int,
    senderId: json['senderId']! as String,
    type: MessageType.fromWire(json['type']! as String),
    body: json['body'] as String?,
    replyToMessageId: json['replyToMessageId'] as String?,
    clientMessageId: json['clientMessageId'] as String?,
    createdAt: DateTime.parse(json['createdAt']! as String),
    editedAt: _date(json['editedAt']),
    deletedAt: _date(json['deletedAt']),
    attachments: [
      for (final item in json['attachments']! as List<Object?>)
        Attachment.fromJson((item! as Map).cast<String, Object?>()),
    ],
  );

  final String id;
  final String conversationId;

  /// The server's order — also the pagination cursor. Never a client clock.
  final int sequence;
  final String senderId;
  final MessageType type;
  final String? body;
  final String? replyToMessageId;

  /// Present only on the viewer's own messages.
  final String? clientMessageId;
  final DateTime createdAt;
  final DateTime? editedAt;
  final DateTime? deletedAt;
  final List<Attachment> attachments;

  bool get isDeleted => deletedAt != null;

  /// This message as a tombstone — the server having confirmed a moderator's
  /// delete (ADR 0029): the body and attachment rows are blanked in every
  /// normal read path, only that it is gone remains. The exact instant re-reads
  /// on reopen; the timeline shows the tombstone from [isDeleted] alone, so the
  /// approximate [at] here is only a non-null marker, never shown.
  Message asTombstone(DateTime at) => Message(
    id: id,
    conversationId: conversationId,
    sequence: sequence,
    senderId: senderId,
    type: type,
    createdAt: createdAt,
    replyToMessageId: replyToMessageId,
    clientMessageId: clientMessageId,
    editedAt: editedAt,
    deletedAt: at,
    attachments: const [],
  );
}

/// A deleted message's original, as the audited moderation review returns it
/// (ADR 0029 §21.3). Unlike [Message] it carries who deleted it and their name
/// — this is the one disclosure of the original content and the moderator,
/// reached only with `community.messages.moderate` and within the 7-day window
/// (`POST …/messages/:id/review`). Past the window the server answers 404 and
/// the UI says the original is no longer available.
class ReviewedMessage {
  const ReviewedMessage({
    required this.id,
    required this.conversationId,
    required this.sequence,
    required this.senderId,
    required this.type,
    required this.createdAt,
    required this.deletedAt,
    required this.deletedBy,
    this.senderName,
    this.deletedByName,
    this.body,
    this.replyToMessageId,
    this.editedAt,
    this.attachments = const [],
  });

  factory ReviewedMessage.fromJson(Map<String, Object?> json) =>
      ReviewedMessage(
        id: json['id']! as String,
        conversationId: json['conversationId']! as String,
        sequence: json['sequence']! as int,
        senderId: json['senderId']! as String,
        senderName: json['senderName'] as String?,
        type: MessageType.fromWire(json['type']! as String),
        body: json['body'] as String?,
        replyToMessageId: json['replyToMessageId'] as String?,
        createdAt: DateTime.parse(json['createdAt']! as String),
        editedAt: _date(json['editedAt']),
        deletedAt: DateTime.parse(json['deletedAt']! as String),
        deletedBy: json['deletedBy']! as String,
        deletedByName: json['deletedByName'] as String?,
        attachments: [
          for (final item
              in (json['attachments'] as List<Object?>? ?? const []))
            Attachment.fromJson((item! as Map).cast<String, Object?>()),
        ],
      );

  final String id;
  final String conversationId;
  final int sequence;
  final String senderId;
  final String? senderName;
  final MessageType type;
  final String? body;
  final String? replyToMessageId;
  final DateTime createdAt;
  final DateTime? editedAt;
  final DateTime deletedAt;

  /// The moderator who deleted it (an account id — never shown in a sentence;
  /// [deletedByName] is the name, when the directory resolved it).
  final String deletedBy;
  final String? deletedByName;
  final List<Attachment> attachments;
}

class MessagePreview {
  const MessagePreview({
    required this.sequence,
    required this.senderId,
    required this.type,
    required this.deleted,
    required this.createdAt,
    this.senderName,
    this.text,
  });

  factory MessagePreview.fromJson(Map<String, Object?> json) => MessagePreview(
    sequence: json['sequence']! as int,
    senderId: json['senderId']! as String,
    senderName: json['senderName'] as String?,
    type: MessageType.fromWire(json['type']! as String),
    text: json['text'] as String?,
    deleted: json['deleted']! as bool,
    createdAt: DateTime.parse(json['createdAt']! as String),
  );

  final int sequence;
  final String senderId;
  final String? senderName;
  final MessageType type;
  final String? text;
  final bool deleted;
  final DateTime createdAt;
}

/// A conversation as the viewer sees it.
class Conversation implements Sourced {
  const Conversation({
    required this.id,
    required this.type,
    required this.memberCount,
    required this.myRole,
    required this.canPost,
    required this.canManageMembers,
    required this.lastSequence,
    required this.lastReadSequence,
    required this.unreadCount,
    required this.createdAt,
    required this.activityAt,
    this.title,
    this.counterpartUserId,
    this.lastMessage,
    this.communityId,
    this.communityKind,
    this.pinnedMessageId,
    this.pinVersion = 0,
    this.origin = DataOrigin.profile,
  });

  factory Conversation.fromJson(Map<String, Object?> json) => Conversation(
    id: json['id']! as String,
    type: ConversationType.fromWire(json['type']! as String),
    title: json['title'] as String?,
    counterpartUserId: json['counterpartUserId'] as String?,
    memberCount: json['memberCount']! as int,
    myRole: ParticipantRole.fromWire(json['myRole']! as String),
    canPost: json['canPost']! as bool,
    canManageMembers: json['canManageMembers']! as bool,
    lastSequence: json['lastSequence']! as int,
    lastReadSequence: json['lastReadSequence']! as int,
    unreadCount: json['unreadCount']! as int,
    lastMessage: json['lastMessage'] == null
        ? null
        : MessagePreview.fromJson(
            (json['lastMessage']! as Map).cast<String, Object?>(),
          ),
    createdAt: DateTime.parse(json['createdAt']! as String),
    activityAt: DateTime.parse(json['activityAt']! as String),
    // Additive on the server: an older one sends nothing, and anything but
    // an id means "not a community's chat".
    communityId: switch (json['communityId']) {
      final String id when id.isNotEmpty => id,
      _ => null,
    },
    // Additive: a community chat's product kind (ADR 0039), so a group reads as
    // "group" even though its conversation `type` is CHANNEL (Q51). An older
    // server, null, or an unknown value → null, and the header falls back to
    // the type label (which never misnames a genuine channel).
    communityKind: switch (json['communityKind']) {
      'GROUP' => CommunityKind.group,
      'CHANNEL' => CommunityKind.channel,
      _ => null,
    },
    // Additive (ADR 0043): the single pinned message's id, or null.
    pinnedMessageId: json['pinnedMessageId'] as String?,
    // The pin's total-order version. An older server omits it — treat that as
    // 0 (never "newest"), so a missing value can't overwrite a real pin.
    pinVersion: json['pinVersion'] as int? ?? 0,
  );

  final String id;
  final ConversationType type;

  /// A group's or channel's title; for a direct conversation, the other
  /// person's name. Null when the server has no name to show.
  final String? title;
  final String? counterpartUserId;
  final int memberCount;
  final ParticipantRole myRole;
  final bool canPost;
  final bool canManageMembers;
  final int lastSequence;
  final int lastReadSequence;

  /// Capped by the server; from [unreadCountCap] on, show "99+".
  final int unreadCount;
  final MessagePreview? lastMessage;
  final DateTime createdAt;
  final DateTime activityAt;

  /// Set when this is a community's chat: who may read it and post in it is
  /// then the community's to say, and it follows the viewer's membership.
  final String? communityId;

  /// For a community chat, the community's product kind (ADR 0039) — used only
  /// to label the header "group" vs "channel". The conversation [type] stays
  /// [ConversationType.channel] for every community chat (Q51); null here means
  /// not a community chat, or the server did not say, so the header falls back
  /// to [type] and never misnames a genuine channel.
  final CommunityKind? communityKind;

  /// The single pinned message's id (ADR 0043), or null. The pin banner
  /// resolves its preview from the loaded timeline, as a reply quote does.
  final String? pinnedMessageId;

  /// The pin's total-order version (ADR 0043 §realtime): the client accepts a
  /// pin change — event or refresh — only when its version is strictly newer.
  final int pinVersion;

  @override
  final DataOrigin origin;

  bool get isCommunityChat => communityId != null;

  static const int unreadCountCap = 100;

  /// How much of a message a list preview shows — the server's cut, too.
  static const int previewLength = 140;

  /// This conversation once [message] has arrived: preview, activity and
  /// unread count as the server would now report them. A message it has
  /// already counted — a duplicate, or an older one arriving late —
  /// changes nothing.
  Conversation withMessage(
    Message message, {
    String? senderName,
    required bool fromViewer,
  }) {
    if (message.sequence <= lastSequence) return this;
    final body = message.body;
    return Conversation(
      id: id,
      type: type,
      title: title,
      counterpartUserId: counterpartUserId,
      memberCount: memberCount,
      myRole: myRole,
      canPost: canPost,
      canManageMembers: canManageMembers,
      lastSequence: message.sequence,
      // Sending a message means having read up to it; the server says so too.
      lastReadSequence: fromViewer ? message.sequence : lastReadSequence,
      unreadCount: fromViewer
          ? 0
          : (unreadCount + 1 > unreadCountCap
                ? unreadCountCap
                : unreadCount + 1),
      lastMessage: MessagePreview(
        sequence: message.sequence,
        senderId: message.senderId,
        senderName: senderName,
        type: message.type,
        text: message.isDeleted || body == null
            ? null
            : String.fromCharCodes(body.runes.take(previewLength)),
        deleted: message.isDeleted,
        createdAt: message.createdAt,
      ),
      createdAt: createdAt,
      activityAt: message.createdAt.isAfter(activityAt)
          ? message.createdAt
          : activityAt,
      communityId: communityId,
      communityKind: communityKind,
      pinnedMessageId: pinnedMessageId,
      pinVersion: pinVersion,
      origin: origin,
    );
  }

  /// This conversation with its latest-message preview shown as deleted — the
  /// content-free effect of a moderator deleting the very message the preview
  /// shows (ADR 0029 §6). Order, activity and unread count are unchanged; only
  /// the preview text is blanked to a neutral "deleted" marker, never the
  /// original. No preview, or one already deleted, returns this unchanged.
  Conversation withDeletedPreview() {
    final last = lastMessage;
    if (last == null || last.deleted) return this;
    return Conversation(
      id: id,
      type: type,
      title: title,
      counterpartUserId: counterpartUserId,
      memberCount: memberCount,
      myRole: myRole,
      canPost: canPost,
      canManageMembers: canManageMembers,
      lastSequence: lastSequence,
      lastReadSequence: lastReadSequence,
      unreadCount: unreadCount,
      lastMessage: MessagePreview(
        sequence: last.sequence,
        senderId: last.senderId,
        senderName: last.senderName,
        type: last.type,
        text: null,
        deleted: true,
        createdAt: last.createdAt,
      ),
      createdAt: createdAt,
      activityAt: activityAt,
      communityId: communityId,
      communityKind: communityKind,
      pinnedMessageId: pinnedMessageId,
      pinVersion: pinVersion,
      origin: origin,
    );
  }

  Conversation withReadUpTo(int sequence) => Conversation(
    id: id,
    type: type,
    title: title,
    counterpartUserId: counterpartUserId,
    memberCount: memberCount,
    myRole: myRole,
    canPost: canPost,
    canManageMembers: canManageMembers,
    lastSequence: lastSequence,
    lastReadSequence: sequence > lastReadSequence ? sequence : lastReadSequence,
    unreadCount: sequence >= lastSequence ? 0 : unreadCount,
    lastMessage: lastMessage,
    createdAt: createdAt,
    activityAt: activityAt,
    communityId: communityId,
    communityKind: communityKind,
    pinnedMessageId: pinnedMessageId,
    pinVersion: pinVersion,
    origin: origin,
  );

  /// This conversation with its single pin set to [messageId] (null = unpinned)
  /// at [version] — the effect of a `message.pinned` realtime event (ADR 0043).
  /// Everything else, including the reply relationships of messages, is
  /// unchanged. The controller calls this only with a strictly newer [version].
  Conversation withPin(String? messageId, int version) => Conversation(
    id: id,
    type: type,
    title: title,
    counterpartUserId: counterpartUserId,
    memberCount: memberCount,
    myRole: myRole,
    canPost: canPost,
    canManageMembers: canManageMembers,
    lastSequence: lastSequence,
    lastReadSequence: lastReadSequence,
    unreadCount: unreadCount,
    lastMessage: lastMessage,
    createdAt: createdAt,
    activityAt: activityAt,
    communityId: communityId,
    communityKind: communityKind,
    pinnedMessageId: messageId,
    pinVersion: version,
    origin: origin,
  );
}

class ConversationPage {
  const ConversationPage({required this.items, this.nextCursor});

  factory ConversationPage.fromJson(Map<String, Object?> json) =>
      ConversationPage(
        items: [
          for (final item in json['items']! as List<Object?>)
            Conversation.fromJson((item! as Map).cast<String, Object?>()),
        ],
        nextCursor: json['nextCursor'] as String?,
      );

  final List<Conversation> items;
  final String? nextCursor;
}

class MessagePage {
  const MessagePage({
    required this.items,
    required this.hasOlder,
    required this.hasNewer,
    required this.lastReadSequence,
    this.senderNames = const {},
    this.senderAvatarAssets = const {},
  });

  factory MessagePage.fromJson(Map<String, Object?> json) {
    final senders = json['senders']! as List<Object?>;
    Map<String, Object?> asMap(Object? sender) =>
        (sender! as Map).cast<String, Object?>();
    return MessagePage(
      items: [
        for (final item in json['items']! as List<Object?>)
          Message.fromJson((item! as Map).cast<String, Object?>()),
      ],
      hasOlder: json['hasOlder']! as bool,
      hasNewer: json['hasNewer']! as bool,
      lastReadSequence: json['lastReadSequence']! as int,
      senderNames: {
        for (final sender in senders)
          (asMap(sender)['userId']! as String):
              asMap(sender)['displayName']! as String,
      },
      // The sender's picture reference, or null (no picture / older server).
      senderAvatarAssets: {
        for (final sender in senders)
          (asMap(sender)['userId']! as String):
              asMap(sender)['avatarFileAssetId'] as String?,
      },
    );
  }

  /// Ascending by sequence.
  final List<Message> items;
  final bool hasOlder;
  final bool hasNewer;
  final int lastReadSequence;

  /// Sender id → display name, resolved at view time (never on the message).
  final Map<String, String> senderNames;

  /// Sender id → Files asset id of their picture (or null). The signed link is
  /// fetched via `MessagingRepository.senderAvatarUrl`.
  final Map<String, String?> senderAvatarAssets;
}

/// A file about to be sent: the bytes and what they claim to be. The server
/// verifies the claim — size and signature — before the file can be used.
class OutgoingFile {
  const OutgoingFile({
    required this.bytes,
    required this.fileName,
    required this.contentType,
    required this.kind,
    this.durationMs,
    this.width,
    this.height,
  });

  final Uint8List bytes;
  final String fileName;
  final String contentType;
  final AttachmentKind kind;
  final int? durationMs;
  final int? width;
  final int? height;
}

/// A refusal the messaging UI should explain, with the server's stable code
/// (`messaging.posting_not_allowed`, `files.too_large`, `network.unreachable`…).
class MessagingException implements Exception {
  const MessagingException(this.code, this.message);

  final String code;
  final String message;

  bool get isNetwork => code == 'network.unreachable';

  /// The viewer may read the chat but not moderate it (ADR 0029) — a member
  /// without `community.messages.moderate`, e.g. a student.
  bool get isModerationForbidden =>
      code == 'messaging.message_moderation_forbidden';

  /// There is no original to review: it was never deleted, it is not this
  /// viewer's to see, or the 7-day review window has passed.
  bool get isReviewUnavailable =>
      code == 'messaging.deleted_message_not_found' ||
      code == 'messaging.deleted_message_review_expired';

  @override
  String toString() => 'MessagingException($code): $message';
}

DateTime? _date(Object? value) =>
    value == null ? null : DateTime.parse(value as String);
